import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { allocatePort, canConnect, waitForPort } from "./ports.mjs";
import { resolveWorktreePaths, validateWorktreeName } from "./paths.mjs";
import {
  isPidAlive,
  listWindowsProcessesReferencingPath,
  terminateProcessTree,
  terminateWindowsProcessesReferencingPath,
} from "./process-utils.mjs";
import { StdioMcpClient } from "./stdio-mcp-client.mjs";
import { startTcpRelay } from "./tcp-relay.mjs";
import { GodotAiBridge } from "./godot-ai-bridge.mjs";
import { GodotAiSessionRegistry, GODOT_AI_SESSION_CONFLICT } from "./godot-ai-session-registry.mjs";
import { GodotAiEditorSettings } from "./godot-ai-editor-settings.mjs";
import {
  GODOT_AI_SESSION_POLL_INTERVAL_MS,
  GODOT_AI_MIN_SESSION_READINESS_TIMEOUT_MS,
  godotGuiProcessNamesForExecutable,
  godotProcessNamesForExecutable,
  isConfiguredGodotProcess,
  isConfiguredGodotGuiProcess,
} from "./godot-ai-policy.mjs";
export {
  godotGuiProcessNameForExecutable,
  godotGuiProcessNamesForExecutable,
  godotProcessNamesForExecutable,
  isConfiguredGodotProcess,
  isConfiguredGodotGuiProcess,
} from "./godot-ai-policy.mjs";

function now() { return new Date().toISOString(); }
function cloneState(state) { return JSON.parse(JSON.stringify(state)); }

function tryParseJsonText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const objectIndex = trimmed.indexOf("{");
  const arrayIndex = trimmed.indexOf("[");
  const start = [objectIndex, arrayIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (Number.isInteger(start) && start > 0) candidates.push(trimmed.slice(start));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return null;
}

function extractStructuredPayload(result) {
  if (!result || typeof result !== "object") return null;
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  if (result.structured_content && typeof result.structured_content === "object") return result.structured_content;
  for (const block of result.content || []) {
    if (block?.type !== "text") continue;
    const parsed = tryParseJsonText(block.text);
    if (parsed !== null && typeof parsed === "object") return parsed;
  }
  return null;
}

function extractLaunchEditorPid(result) {
  const candidates = [];
  const structured = extractStructuredPayload(result);
  if (structured) candidates.push(structured);
  if (result && typeof result === "object") candidates.push(result);
  for (const candidate of candidates) {
    for (const key of ["pid", "editor_pid", "ProcessId"]) {
      const value = Number(candidate?.[key]);
      if (Number.isInteger(value) && value > 0) return value;
    }
  }
  return null;
}

function godotAiFailure(code, message) {
  const error = new Error(typeof message === "string" ? message : String(message?.message || message || code));
  error.code = code;
  return error;
}

async function closeWriteStream(stream, timeoutMs = 3000) {
  if (!stream || stream.closed || stream.destroyed) return;
  stream.end();
  const completed = await Promise.race([
    once(stream, "close").then(() => true).catch(() => true),
    once(stream, "finish").then(() => true).catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!completed && !stream.closed && !stream.destroyed) stream.destroy();
}

async function waitForChildProcessClose(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    once(child, "close").then(() => true).catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export class SessionManager {
  constructor(config, logger, dependencies = {}) {
    this.config = config;
    this.logger = logger;
    this.dependencies = dependencies && typeof dependencies === "object" ? dependencies : {};
    this.records = new Map();
    this.runtime = new Map();
    this.locks = new Map();
    this.godotAiGlobalLock = null;
    this.reconcileTimer = null;
    this.godotAiRegistry = this.dependencies.godotAiSessionRegistry || new GodotAiSessionRegistry();
    this.isPidAliveFn = typeof this.dependencies.isPidAlive === "function"
      ? this.dependencies.isPidAlive
      : isPidAlive;
  }

  async init() {
    await mkdir(this.config.paths.stateDirectory, { recursive: true });
    await mkdir(this.config.paths.logsDirectory, { recursive: true });
    const files = await readdir(this.config.paths.stateDirectory).catch(() => []);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      try {
        const record = JSON.parse(await readFile(path.join(this.config.paths.stateDirectory, file), "utf8"));
        validateWorktreeName(record.worktree_name);
        const resolved = resolveWorktreePaths(record.worktree_name, this.config);
        const pathChanged = record.host_project_path !== resolved.hostPath
          || record.container_project_path !== resolved.containerPath;
        record.host_project_path = resolved.hostPath;
        record.container_project_path = resolved.containerPath;
        record.residual_pids = Array.isArray(record.residual_pids) ? record.residual_pids : [];
        record.directory_released = Boolean(record.directory_released);
        this.#normalizeGodotAiFields(record);
        this.records.set(record.worktree_name, record);
        if (pathChanged) {
          await this.#persist(record);
          await this.logger.info("Paths de state atualizados para a configuracao vigente.", {
            worktree: record.worktree_name,
            host_project_path: record.host_project_path,
            container_project_path: record.container_project_path,
          });
        }
      } catch (error) {
        await this.logger.warn("Registro de worktree invalido ignorado.", { file, error: error.message });
      }
    }
    await this.reconcileAll("startup");
    this.reconcileTimer = setInterval(() => this.reconcileAll("periodic").catch((error) => this.logger.error("Falha na reconciliacao periodica.", { error: error.message })), this.config.service.reconciliationIntervalSeconds * 1000);
    this.reconcileTimer.unref();
  }

  async activateWorktree(name, source = "mcp") {
    return await this.#withLock(name, async () => {
      const paths = resolveWorktreePaths(name, this.config);
      await this.#validateProject(paths.hostPath);
      let record = this.records.get(name) || this.#newRecord(paths);
      this.#normalizeGodotAiFields(record);
      const previousGodotPid = record.godot_pid;
      const previousMcpPid = record.godot_mcp_pid;
      record.host_project_path = paths.hostPath;
      record.container_project_path = paths.containerPath;
      record.residual_pids = [];
      record.directory_released = false;
      record.desired_active = true;
      record.shutdown_not_before = null;
      record.last_requested_at = now();
      record.last_request_source = source;
      this.records.set(name, record);
      await this.#persist(record);
      await this.#ensureRunning(record);
      if (record.status === "ready") await this.#ensureGodotAiPorts(record);
      if (
        record.status === "ready"
        && Number.isInteger(record.godot_ai_http_port)
        && Number.isInteger(record.godot_ai_ws_port)
      ) {
        await this.#ensureGodotAiCriticalSection(record);
      }
      const status = this.getStatus(name);
      return {
        ...status,
        reused_existing_runtime: Boolean(
          previousGodotPid
          && previousMcpPid
          && previousGodotPid === status.godot_pid
          && previousMcpPid === status.godot_mcp_pid
        ),
      };
    });
  }

  async ensureWorktree(name, source = "ensure") {
    return await this.activateWorktree(name, source);
  }

  async deactivateWorktree(name, source = "mcp") {
    return await this.#withLock(name, async () => {
      const record = this.records.get(name);
      if (!record) return { ...this.getStatus(name), already_inactive: true };

      const runtime = this.runtime.get(name);
      if (
        !record.desired_active
        && !runtime
        && record.status === "stopped"
        && record.directory_released
        && (!record.residual_pids || record.residual_pids.length === 0)
      ) {
        return { ...this.getStatus(name), already_inactive: true };
      }

      record.desired_active = false;
      const shutdownDelay = this.config.sessions.inactiveShutdownDelaySeconds ?? 0;
      record.shutdown_not_before = shutdownDelay > 0
        ? new Date(Date.now() + shutdownDelay * 1000).toISOString()
        : null;
      record.last_requested_at = now();
      record.last_request_source = source;
      await this.#persist(record);
      // Godot AI release happens before TODO9 #stopRuntime (including delayed shutdown).
      // Do not enter the Godot AI critical section from deactivate.
      await this.#releaseGodotAiAssociation(record);
      if (shutdownDelay === 0) await this.#stopRuntime(record, "deactivated");
      return { ...this.getStatus(name), already_inactive: false };
    });
  }

  getStatus(name) {
    const record = this.records.get(name);
    if (!record) {
      return {
        worktree_name: name,
        registered: false,
        desired_active: false,
        status: "not_registered",
        residual_pids: [],
        directory_released: true,
        godot_pid: null,
        godot_mcp_pid: null,
        lsp: {
          host: this.config.godot.lspHostForHermes,
          port: null,
          godot_internal_port: null,
          ready: false,
        },
        dap: { host: this.config.godot.lspHostForHermes, port: null },
        godot_mcp_ready: false,
        project_started: false,
        godot_ai: this.#publicGodotAiStatus(null),
      };
    }
    this.#normalizeGodotAiFields(record);
    const runtime = this.runtime.get(name);
    return {
      ...cloneState(record),
      registered: true,
      lsp: {
        host: this.config.godot.lspHostForHermes,
        port: record.lsp_port,
        godot_internal_port: record.godot_lsp_port,
        ready: record.status === "ready" && Boolean(record.lsp_port),
      },
      dap: { host: this.config.godot.lspHostForHermes, port: record.dap_port },
      godot_mcp_ready: Boolean(runtime?.mcp?.isAlive),
      project_started: Boolean(runtime?.projectStarted),
      godot_ai: this.#publicGodotAiStatus(record),
    };
  }

  listStatuses() {
    return [...this.records.keys()].sort().map((name) => this.getStatus(name));
  }

  async callGodotTool(name, toolName, args) {
    if (toolName === "stop_project") return await this.stopProject(name);
    if (toolName === "get_debug_output") {
      const runtime = this.runtime.get(name);
      if (!runtime?.mcp?.isAlive || !runtime.projectStarted) {
        return {
          worktree_name: name,
          status: "not_running",
          project_started: false,
          output: "",
        };
      }
    }

    const session = await this.ensureWorktree(name, `tool:${toolName}`);
    const runtime = this.runtime.get(name);
    if (!runtime?.mcp?.isAlive) throw new Error(`Godot MCP dedicado de ${name} nao esta pronto.`);
    if (!runtime.mcp.hasTool(toolName)) throw new Error(`A versao instalada do Godot MCP nao oferece a tool '${toolName}'.`);
    const upstreamArgs = this.#mapGodotArguments(toolName, args, session.host_project_path);
    const result = await runtime.mcp.callTool(toolName, upstreamArgs);
    if (toolName === "run_project") runtime.projectStarted = true;
    return result;
  }

  async stopProject(name) {
    return await this.#withLock(name, async () => {
      const runtime = this.runtime.get(name);
      if (!runtime?.mcp?.isAlive || !runtime.projectStarted) {
        return {
          worktree_name: name,
          status: "already_stopped",
          project_started: false,
        };
      }
      if (!runtime.mcp.hasTool("stop_project")) {
        throw new Error(`A versao instalada do Godot MCP nao oferece a tool 'stop_project'.`);
      }
      const result = await runtime.mcp.callTool("stop_project", {});
      runtime.projectStarted = false;
      return result;
    });
  }

  async reconcileAll(reason) {
    for (const name of [...this.records.keys()]) {
      await this.#withLock(name, async () => {
        const record = this.records.get(name);
        if (!record) return;
        const exists = await stat(record.host_project_path).then((item) => item.isDirectory()).catch(() => false);
        if (!exists) {
          await this.#stopRuntime(record, "worktree_missing");
          if (this.config.sessions.removeConfigurationWhenWorktreeMissing) {
            this.records.delete(name);
            await rm(this.#recordPath(name), { force: true });
            await this.logger.info("Registro removido porque a worktree nao existe mais.", { worktree: name });
          }
          return;
        }
        if (record.desired_active) {
          if (record.status !== "failed" || this.config.sessions.restartActiveSessionsAfterCrash) await this.#ensureRunning(record);
          if (record.desired_active && record.status === "ready") await this.#ensureGodotAiPorts(record);
          if (
            record.desired_active
            && record.status === "ready"
            && Number.isInteger(record.godot_ai_http_port)
            && Number.isInteger(record.godot_ai_ws_port)
          ) {
            await this.#reconcileGodotAiSession(record);
          }
        } else if (this.runtime.has(name)) {
          const due = !record.shutdown_not_before || Date.now() >= Date.parse(record.shutdown_not_before);
          if (due) await this.#stopRuntime(record, `reconcile_${reason}`);
        }
      });
    }
  }

  async shutdown() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const name of [...this.runtime.keys()]) {
      await this.#withLock(name, async () => {
        const record = this.records.get(name);
        if (record) await this.#stopRuntime(record, "service_shutdown");
      });
    }
  }

  #newRecord(paths) {
    return {
      schema_version: 1,
      worktree_name: paths.name,
      container_project_path: paths.containerPath,
      host_project_path: paths.hostPath,
      desired_active: false,
      status: "new",
      lsp_port: null,
      godot_lsp_port: null,
      dap_port: null,
      godot_pid: null,
      godot_mcp_pid: null,
      residual_pids: [],
      directory_released: false,
      created_at: now(),
      updated_at: now(),
      started_at: null,
      ready_at: null,
      last_error: null,
      shutdown_not_before: null,
      godot_ai_http_port: null,
      godot_ai_ws_port: null,
      godot_ai_gui_pid: null,
      godot_ai_session_id: null,
      godot_ai_status: "runtime_stopped",
      godot_ai_last_error: null,
    };
  }

  #normalizeGodotAiFields(record) {
    if (!record) return;
    record.godot_ai_http_port = Number.isInteger(record.godot_ai_http_port) ? record.godot_ai_http_port : null;
    record.godot_ai_ws_port = Number.isInteger(record.godot_ai_ws_port) ? record.godot_ai_ws_port : null;
    record.godot_ai_gui_pid = Number.isInteger(record.godot_ai_gui_pid) ? record.godot_ai_gui_pid : null;
    record.godot_ai_session_id = typeof record.godot_ai_session_id === "string" ? record.godot_ai_session_id : null;
    if (
      record.godot_ai_status !== "runtime_stopped"
      && record.godot_ai_status !== "runtime_no_session"
      && record.godot_ai_status !== "session_ready"
      && record.godot_ai_status !== "session_invalid"
      && record.godot_ai_status !== "integration_error"
    ) {
      record.godot_ai_status = "runtime_stopped";
    }
    const lastError = record.godot_ai_last_error;
    if (
      !lastError
      || typeof lastError !== "object"
      || Array.isArray(lastError)
      || typeof lastError.code !== "string"
      || typeof lastError.message !== "string"
    ) {
      record.godot_ai_last_error = null;
    } else {
      record.godot_ai_last_error = { code: lastError.code, message: lastError.message };
    }
  }

  #publicGodotAiStatus(record) {
    if (!record) {
      return {
        status: "runtime_stopped",
        session_id: null,
        http_port: null,
        ws_port: null,
        gui_pid: null,
        last_error: null,
      };
    }
    this.#normalizeGodotAiFields(record);
    const httpPort = record.godot_ai_http_port;
    const wsPort = record.godot_ai_ws_port;
    // Persisted session_id is an invalidatable cache; routing only consumes session_ready.
    if (record.status !== "ready") {
      return {
        status: "runtime_stopped",
        session_id: null,
        http_port: httpPort,
        ws_port: wsPort,
        gui_pid: null,
        last_error: null,
      };
    }
    if (record.godot_ai_status === "integration_error") {
      return {
        status: "integration_error",
        session_id: null,
        http_port: httpPort,
        ws_port: wsPort,
        gui_pid: record.godot_ai_gui_pid,
        last_error: record.godot_ai_last_error,
      };
    }
    const registryUsable = this.godotAiRegistry?.usable?.(record.worktree_name) === true;
    // session_ready only when the in-process registry still marks the association usable.
    if (registryUsable) {
      return {
        status: "session_ready",
        session_id: record.godot_ai_session_id,
        http_port: httpPort,
        ws_port: wsPort,
        gui_pid: record.godot_ai_gui_pid,
        last_error: null,
      };
    }
    const diagnosticSessionId = typeof record.godot_ai_session_id === "string" && record.godot_ai_session_id
      ? record.godot_ai_session_id
      : null;
    if (diagnosticSessionId || record.godot_ai_status === "session_invalid") {
      return {
        status: "session_invalid",
        session_id: diagnosticSessionId,
        http_port: httpPort,
        ws_port: wsPort,
        gui_pid: record.godot_ai_gui_pid,
        last_error: record.godot_ai_last_error,
      };
    }
    return {
      status: "runtime_no_session",
      session_id: null,
      http_port: httpPort,
      ws_port: wsPort,
      gui_pid: null,
      last_error: null,
    };
  }

  async #releaseGodotAiAssociation(record) {
    if (!record) return;
    this.#normalizeGodotAiFields(record);
    const worktreeName = record.worktree_name;
    try {
      this.godotAiRegistry?.release?.(worktreeName);
    } catch {
      // Release is best-effort; stop path must still proceed.
    }
    if (typeof this.dependencies.onGodotAiRelease === "function") {
      try {
        this.dependencies.onGodotAiRelease({
          worktree_name: worktreeName,
          record_status: record.status,
          has_runtime: this.runtime.has(worktreeName),
        });
      } catch {
        // Test/order hooks must never block release/stop.
      }
    }
    // Clean release: association not usable; sticky HTTP/WS ports remain.
    record.godot_ai_status = "runtime_no_session";
    record.godot_ai_last_error = null;
    record.godot_ai_session_id = null;
    record.godot_ai_gui_pid = null;
    await this.#persist(record);
  }

  async #reconcileGodotAiSession(record) {
    this.#normalizeGodotAiFields(record);
    if (
      record.status !== "ready"
      || !Number.isInteger(record.godot_ai_http_port)
      || !Number.isInteger(record.godot_ai_ws_port)
    ) {
      return;
    }

    const usable = this.godotAiRegistry?.usable?.(record.worktree_name) === true;
    const healthyGui = await this.#isHealthyGodotAiGui(record, record.godot_ai_gui_pid);
    if (usable && healthyGui) {
      // Keep session_ready. Do not launch_editor, attach, or rebind.
      if (record.godot_ai_status !== "session_ready" || record.godot_ai_last_error !== null) {
        record.godot_ai_status = "session_ready";
        record.godot_ai_last_error = null;
        await this.#persist(record);
      }
      return;
    }

    // Observed revalidation failed: mark invalid until reconvergence.
    try {
      this.godotAiRegistry?.markInvalid?.(record.worktree_name, {
        code: "SESSION_REVALIDATE_FAILED",
        message: "Godot AI session is not usable or GUI is unhealthy; reconverging.",
      });
    } catch {
      // No registry entry is fine (e.g. process restart with empty registry).
    }

    if (record.godot_ai_status !== "integration_error") {
      record.godot_ai_status = "session_invalid";
      await this.#persist(record);
    }

    // Reuse activate critical section (reapplies sticky EditorSettings ports, then launch/reuse/attach/bind).
    await this.#ensureGodotAiCriticalSection(record);
  }

  async #ensureGodotAiPorts(record) {
    this.#normalizeGodotAiFields(record);
    if (record.status !== "ready") return;

    const host = this.config.godot.localReadyHost;
    const stickyPair = Number.isInteger(record.godot_ai_http_port) && Number.isInteger(record.godot_ai_ws_port);
    if (stickyPair) {
      // Sticky pair already exists: do not reset status/session_id/gui_pid/last_error.
      return;
    }

    try {
      const reservedHttp = new Set(
        [...this.records.values()]
          .filter((item) => item.worktree_name !== record.worktree_name)
          .map((item) => item.godot_ai_http_port)
          .filter(Number.isInteger),
      );
      const reservedWs = new Set(
        [...this.records.values()]
          .filter((item) => item.worktree_name !== record.worktree_name)
          .map((item) => item.godot_ai_ws_port)
          .filter(Number.isInteger),
      );
      if (!Number.isInteger(record.godot_ai_http_port)) {
        record.godot_ai_http_port = await allocatePort(
          host,
          this.config.ports.godotAiHttpStart,
          this.config.ports.godotAiHttpEnd,
          reservedHttp,
        );
      }
      if (!Number.isInteger(record.godot_ai_ws_port)) {
        record.godot_ai_ws_port = await allocatePort(
          host,
          this.config.ports.godotAiWsStart,
          this.config.ports.godotAiWsEnd,
          reservedWs,
        );
      }
      record.godot_ai_status = "runtime_no_session";
      record.godot_ai_last_error = null;
      await this.#persist(record);
    } catch (error) {
      record.godot_ai_status = "integration_error";
      record.godot_ai_last_error = {
        code: "godot_ai_port_allocation_failed",
        message: error.message,
      };
      await this.#persist(record);
      await this.logger.warn("Falha ao alocar portas HTTP/WS Godot AI; runtime TODO9 permanece ready.", {
        worktree: record.worktree_name,
        error: error.message,
      });
    }
  }

  async #ensureGodotAiCriticalSection(record) {
    return await this.#withGodotAiGlobalLock(async () => {
      try {
        await this.#runGodotAiCriticalSection(record);
      } catch (error) {
        const code = typeof error?.code === "string" && error.code
          ? error.code
          : "godot_ai_attach_failed";
        record.godot_ai_status = "integration_error";
        record.godot_ai_last_error = {
          code,
          message: error?.message || String(error),
        };
        // Keep sticky HTTP/WS ports. gui_pid may remain if a GUI was observed.
        await this.#persist(record);
        await this.logger.warn("Falha na secao critica Godot AI; runtime TODO9 permanece ready.", {
          worktree: record.worktree_name,
          code,
          error: error?.message || String(error),
        });
      }
    });
  }

  async #runGodotAiCriticalSection(record) {
    this.#normalizeGodotAiFields(record);
    const httpPort = record.godot_ai_http_port;
    const wsPort = record.godot_ai_ws_port;
    if (!Number.isInteger(httpPort) || !Number.isInteger(wsPort)) {
      throw godotAiFailure("godot_ai_port_allocation_failed", "HTTP/WS Godot AI ports are not allocated.");
    }

    const persistedGuiPid = record.godot_ai_gui_pid;
    const healthyPersisted = await this.#isHealthyGodotAiGui(record, persistedGuiPid);
    if (this.godotAiRegistry.usable(record.worktree_name) && healthyPersisted) {
      // Idempotent activate: skip launch/attach/rebind when session is usable and GUI healthy.
      if (record.godot_ai_status !== "session_ready" || record.godot_ai_last_error !== null) {
        record.godot_ai_status = "session_ready";
        record.godot_ai_last_error = null;
        await this.#persist(record);
      }
      return;
    }

    // 1) EditorSettings write (before wait-listen; no further mutation after listen starts).
    const appdataDir = this.dependencies.godotAiAppdataDir || process.env.APPDATA;
    const settingsPath = GodotAiEditorSettings.resolveDefaultPath({ appdataDir });
    const applied = await GodotAiEditorSettings.applyPorts({
      settingsPath,
      httpPort,
      wsPort,
    });
    if (!applied?.ok) {
      throw godotAiFailure(
        "godot_ai_editor_settings_failed",
        applied?.message || "Failed to apply Godot AI EditorSettings ports.",
      );
    }

    // 2) Launch or reuse GUI.
    let guiPid = await this.#resolveGodotAiGuiPid(record);

    // 3) Wait listen on HTTP only.
    const timeoutMs = this.config.sessions.readyTimeoutSeconds * 1000;
    const waitListen = typeof this.dependencies.godotAiWaitForListen === "function"
      ? this.dependencies.godotAiWaitForListen
      : waitForPort;
    try {
      await waitListen(this.config.godot.localReadyHost, httpPort, timeoutMs);
    } catch (error) {
      throw godotAiFailure("godot_ai_listen_timeout", error?.message || error);
    }

    // 4) Attach via per-worktree bridge.
    const bridge = this.#getOrCreateGodotAiBridge(record.worktree_name);
    const attachOptions = {
      httpPort,
      wsPort,
      logger: this.logger,
      label: record.worktree_name,
    };
    if (typeof this.dependencies.godotAiAttachOptions === "function") {
      Object.assign(attachOptions, this.dependencies.godotAiAttachOptions({ httpPort, wsPort }) || {});
    }
    const attached = await bridge.attach(attachOptions);
    if (!attached?.ok) {
      throw godotAiFailure(
        "godot_ai_attach_failed",
        attached?.message || "Godot AI attach failed.",
      );
    }

    // 5) Deterministic session selection with bounded readiness wait.
    // Never session_activate; never sessions[0] by order.
    const sessionId = await this.#waitForGodotAiSessionId(
      bridge,
      attached.sessions,
      guiPid,
      timeoutMs,
      record.worktree_name,
    );

    // 6) Registry bind.
    try {
      this.godotAiRegistry.bind({
        worktree_name: record.worktree_name,
        session_id: sessionId,
        runtime_pid: guiPid,
        http_port: httpPort,
        ws_port: wsPort,
        observed_state: "session_ready",
      });
    } catch (error) {
      if (error?.code === GODOT_AI_SESSION_CONFLICT) {
        throw godotAiFailure("godot_ai_registry_conflict", error.message);
      }
      throw godotAiFailure("godot_ai_registry_conflict", error?.message || error);
    }

    record.godot_ai_session_id = sessionId;
    record.godot_ai_gui_pid = Number.isInteger(guiPid) ? guiPid : record.godot_ai_gui_pid;
    record.godot_ai_status = "session_ready";
    record.godot_ai_last_error = null;
    await this.#persist(record);
  }

  #getOrCreateGodotAiBridge(worktreeName) {
    let runtime = this.runtime.get(worktreeName);
    if (!runtime) {
      runtime = { godot: null, stdout: null, stderr: null, mcp: null, relay: null, projectStarted: false, godotAiBridge: null };
      this.runtime.set(worktreeName, runtime);
    }
    if (!runtime.godotAiBridge) {
      runtime.godotAiBridge = typeof this.dependencies.godotAiBridgeFactory === "function"
        ? this.dependencies.godotAiBridgeFactory({ worktree_name: worktreeName })
        : new GodotAiBridge();
    }
    return runtime.godotAiBridge;
  }

  async #resolveGodotAiGuiPid(record) {
    const healthy = await this.#listHealthyGodotAiGuis(record);
    if (healthy.length === 1) {
      record.godot_ai_gui_pid = healthy[0].pid;
      await this.#persist(record);
      return healthy[0].pid;
    }
    if (healthy.length > 1) {
      const preferred = Number.isInteger(record.godot_ai_gui_pid)
        ? healthy.find((item) => item.pid === record.godot_ai_gui_pid)
        : null;
      if (preferred) {
        return preferred.pid;
      }
      await this.logger.warn("Multiple healthy Godot AI GUI candidates.", {
        worktree: record.worktree_name,
        candidates: healthy.map((item) => ({
          pid: item.pid,
          name: item.name,
          command_line: item.command_line,
        })),
      });
      throw godotAiFailure(
        "godot_ai_launch_editor_failed",
        `Multiple healthy Godot AI GUI candidates for worktree '${record.worktree_name}'.`,
      );
    }

    // No healthy GUI: launch_editor via dedicated Godot MCP.
    const runtime = this.runtime.get(record.worktree_name);
    if (!runtime?.mcp?.isAlive) {
      throw godotAiFailure("godot_ai_launch_editor_failed", "Dedicated Godot MCP is not ready for launch_editor.");
    }
    if (!runtime.mcp.hasTool("launch_editor")) {
      throw godotAiFailure("godot_ai_launch_editor_failed", "Dedicated Godot MCP does not advertise launch_editor.");
    }

    let launchResult;
    try {
      const args = this.#mapGodotArguments("launch_editor", {}, record.host_project_path);
      launchResult = await runtime.mcp.callTool("launch_editor", args);
    } catch (error) {
      throw godotAiFailure("godot_ai_launch_editor_failed", error?.message || error);
    }

    let guiPid = extractLaunchEditorPid(launchResult);
    if (!Number.isInteger(guiPid)) {
      const afterLaunch = await this.#listHealthyGodotAiGuis(record);
      if (afterLaunch.length === 1) guiPid = afterLaunch[0].pid;
      else if (afterLaunch.length > 1) {
        await this.logger.warn("Multiple Godot AI GUI candidates after launch_editor.", {
          worktree: record.worktree_name,
          candidates: afterLaunch.map((item) => ({
            pid: item.pid,
            name: item.name,
            command_line: item.command_line,
          })),
        });
        throw godotAiFailure(
          "godot_ai_launch_editor_failed",
          `Multiple GUI candidates after launch_editor for worktree '${record.worktree_name}'.`,
        );
      }
    }
    if (!Number.isInteger(guiPid)) {
      throw godotAiFailure("godot_ai_launch_editor_failed", "launch_editor did not yield an observable GUI pid.");
    }

    record.godot_ai_gui_pid = guiPid;
    await this.#persist(record);
    return guiPid;
  }

  async #listHealthyGodotAiGuis(record) {
    const processNames = godotGuiProcessNamesForExecutable(this.config.paths.godotExecutable);
    const lister = typeof this.dependencies.godotAiProcessLister === "function"
      ? this.dependencies.godotAiProcessLister
      : (pathFragment, config, allowedNames) => listWindowsProcessesReferencingPath(
          pathFragment,
          config,
          allowedNames,
        );
    const processes = await lister(record.host_project_path, this.config, processNames);
    const rows = Array.isArray(processes) ? processes : [];
    const healthy = [];
    for (const row of rows) {
      const pid = Number(row?.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (!isConfiguredGodotGuiProcess(row, this.config.paths.godotExecutable)) continue;
      if (!(await this.#isHealthyGodotAiGui(record, pid, row))) continue;
      healthy.push({
        pid,
        command_line: String(row?.command_line || ""),
        name: String(row?.name || ""),
      });
    }
    return healthy;
  }

  async #isHealthyGodotAiGui(record, pid, processInfo = null) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === record.godot_pid) return false;
    if (!this.isPidAliveFn(pid)) return false;

    let effectiveProcessInfo = processInfo;
    let commandLine = typeof effectiveProcessInfo?.command_line === "string"
      ? effectiveProcessInfo.command_line
      : null;
    if (commandLine == null) {
      const processNames = godotGuiProcessNamesForExecutable(this.config.paths.godotExecutable);
      const lister = typeof this.dependencies.godotAiProcessLister === "function"
        ? this.dependencies.godotAiProcessLister
        : (pathFragment, config, allowedNames) => listWindowsProcessesReferencingPath(
            pathFragment,
            config,
            allowedNames,
          );
      const processes = await lister(record.host_project_path, this.config, processNames);
      const match = (Array.isArray(processes) ? processes : []).find((row) => Number(row?.pid) === pid);
      effectiveProcessInfo = match || null;
      commandLine = typeof match?.command_line === "string" ? match.command_line : "";
    }
    if (!isConfiguredGodotGuiProcess(effectiveProcessInfo, this.config.paths.godotExecutable)) return false;
    if (!commandLine) return false;
    const pathNeedle = String(record.host_project_path || "");
    if (!pathNeedle || !commandLine.toLowerCase().includes(pathNeedle.toLowerCase())) return false;
    if (commandLine.includes("--headless")) return false;
    return true;
  }

  async #waitForGodotAiSessionId(bridge, initialSessions, guiPid, timeoutMs, worktreeName) {
    const boundedTimeoutMs = Math.max(
      GODOT_AI_MIN_SESSION_READINESS_TIMEOUT_MS,
      Number(timeoutMs) || GODOT_AI_MIN_SESSION_READINESS_TIMEOUT_MS,
    );
    const deadline = Date.now() + boundedTimeoutMs;
    let sessions = Array.isArray(initialSessions) ? initialSessions : [];
    let polls = 0;
    let waitingLogged = false;

    while (true) {
      try {
        const sessionId = this.#selectGodotAiSessionId(sessions, guiPid);
        if (polls > 0) {
          await this.logger.info("Godot AI session registrada apos espera de readiness.", {
            worktree: worktreeName,
            gui_pid: guiPid,
            polls,
          });
        }
        return sessionId;
      } catch (error) {
        // A real ambiguity must remain fail-closed. Only "no session yet" is retryable.
        if (error?.code !== "godot_ai_no_session") throw error;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw godotAiFailure(
          "godot_ai_session_timeout",
          `Godot AI session did not become available for gui_pid=${guiPid} within ${boundedTimeoutMs}ms.`,
        );
      }

      if (!bridge?.isConnected || typeof bridge.listSessions !== "function") {
        throw godotAiFailure(
          "godot_ai_session_list_unavailable",
          "Godot AI bridge cannot list sessions while waiting for editor registration.",
        );
      }

      if (!waitingLogged) {
        waitingLogged = true;
        await this.logger.info("Aguardando registro da sessao Godot AI do editor.", {
          worktree: worktreeName,
          gui_pid: guiPid,
          timeout_ms: boundedTimeoutMs,
        });
      }

      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(GODOT_AI_SESSION_POLL_INTERVAL_MS, remainingMs),
      ));

      const listed = await bridge.listSessions();
      polls += 1;
      if (!listed?.ok) {
        throw godotAiFailure(
          "godot_ai_session_list_failed",
          listed?.message || "Godot AI session_manage list failed while waiting for editor registration.",
        );
      }
      sessions = Array.isArray(listed.sessions) ? listed.sessions : [];
    }
  }

  #selectGodotAiSessionId(sessions, guiPid) {
    const list = Array.isArray(sessions) ? sessions : [];
    const withId = list.filter((session) => typeof session?.session_id === "string" && session.session_id.trim() !== "");

    if (Number.isInteger(guiPid) && guiPid > 0) {
      const matched = withId.filter((session) => {
        const candidate = session.editor_pid ?? session.pid ?? session.runtime_pid;
        return Number(candidate) === guiPid;
      });
      if (matched.length === 1) return matched[0].session_id;
      if (matched.length > 1) {
        throw godotAiFailure(
          "godot_ai_session_ambiguous",
          `Multiple Godot AI sessions matched gui_pid=${guiPid}.`,
        );
      }
    }

    if (withId.length === 1) return withId[0].session_id;
    if (withId.length === 0) {
      throw godotAiFailure("godot_ai_no_session", "Godot AI attach returned no usable session_id.");
    }
    throw godotAiFailure(
      "godot_ai_session_ambiguous",
      `Godot AI attach returned ${withId.length} sessions without a unique editor_pid match.`,
    );
  }

  async #ensureRunning(record) {
    const current = this.runtime.get(record.worktree_name);
    if (current?.godot && current.godot.exitCode === null && current.mcp?.isAlive
      && (!this.config.godot.lspRelayEnabled || current.relay)
      && await canConnect(this.config.godot.localReadyHost, record.godot_lsp_port, 500)) {
      record.status = "ready";
      record.updated_at = now();
      await this.#persist(record);
      return;
    }

    const activeCount = [...this.runtime.keys()].filter((name) => name !== record.worktree_name).length;
    if (activeCount >= this.config.service.maxActiveWorktrees) {
      record.status = "waiting_capacity";
      record.last_error = `Limite de ${this.config.service.maxActiveWorktrees} worktrees ativas atingido.`;
      await this.#persist(record);
      return;
    }

    const needsCleanup = Boolean(
      current
      || (record.godot_pid && isPidAlive(record.godot_pid))
      || (record.godot_mcp_pid && isPidAlive(record.godot_mcp_pid))
      || (Array.isArray(record.residual_pids) && record.residual_pids.length > 0)
    );
    if (needsCleanup) await this.#stopRuntime(record, "restart_before_start");
    await this.#validateProject(record.host_project_path);
    record.status = "starting";
    record.last_error = null;
    record.residual_pids = [];
    record.directory_released = false;
    record.started_at = now();
    record.ready_at = null;

    const reservedGodotLsp = new Set([...this.records.values()].filter((item) => item.worktree_name !== record.worktree_name).map((item) => item.godot_lsp_port).filter(Number.isInteger));
    const reservedLsp = new Set([...this.records.values()].filter((item) => item.worktree_name !== record.worktree_name).map((item) => item.lsp_port).filter(Number.isInteger));
    const reservedDap = new Set([...this.records.values()].filter((item) => item.worktree_name !== record.worktree_name).map((item) => item.dap_port).filter(Number.isInteger));
    record.godot_lsp_port = await allocatePort(this.config.godot.localReadyHost, this.config.ports.lspStart, this.config.ports.lspEnd, reservedGodotLsp);
    record.lsp_port = this.config.godot.lspRelayEnabled
      ? await allocatePort(this.config.service.bindHost, this.config.ports.lspProxyStart, this.config.ports.lspProxyEnd, reservedLsp)
      : record.godot_lsp_port;
    record.dap_port = await allocatePort(this.config.godot.localReadyHost, this.config.ports.dapStart, this.config.ports.dapEnd, reservedDap);
    await this.#persist(record);

    const logBase = path.join(this.config.paths.logsDirectory, record.worktree_name);
    await mkdir(logBase, { recursive: true });
    const stdout = createWriteStream(path.join(logBase, "godot-headless.stdout.log"), { flags: "a" });
    const stderr = createWriteStream(path.join(logBase, "godot-headless.stderr.log"), { flags: "a" });
    const args = [
      ...this.config.godot.executableArgsPrefix,
      "--headless", "--editor",
      "--path", record.host_project_path,
      "--lsp-port", String(record.godot_lsp_port),
      "--dap-port", String(record.dap_port),
      ...this.config.godot.additionalEditorArgs,
    ];
    const godot = spawn(this.config.paths.godotExecutable, args, {
      // Nunca use a worktree como cwd: no Windows isso mantem o diretorio bloqueado.
      // O argumento --path ja seleciona explicitamente o projeto Godot.
      cwd: this.config.appRoot,
      env: process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    godot.stdout.pipe(stdout);
    godot.stderr.pipe(stderr);
    record.godot_pid = godot.pid;
    this.runtime.set(record.worktree_name, { godot, stdout, stderr, mcp: null, relay: null, projectStarted: false, godotAiBridge: null });
    godot.once("close", (code, signal) => {
      this.#onGodotExit(record.worktree_name, code, signal).catch((error) => {
        this.logger.error("Falha tratando encerramento do Godot.", {
          worktree: record.worktree_name,
          error: error.message,
        });
      });
    });

    try {
      await waitForPort(this.config.godot.localReadyHost, record.godot_lsp_port, this.config.sessions.readyTimeoutSeconds * 1000, godot);
      if (this.config.godot.lspRelayEnabled) {
        const relay = await startTcpRelay({
          bindHost: this.config.service.bindHost, bindPort: record.lsp_port,
          targetHost: this.config.godot.localReadyHost, targetPort: record.godot_lsp_port,
          logger: this.logger, worktree: record.worktree_name,
        });
        this.runtime.get(record.worktree_name).relay = relay;
      }
      if (this.config.sessions.requireClassCacheBeforeReady) await this.#waitForClassCache(record.host_project_path, godot);

      const mcp = new StdioMcpClient({
        command: this.config.godotMcp.command,
        args: this.config.godotMcp.args,
        cwd: this.config.appRoot,
        env: { ...process.env, GODOT_PATH: this.config.paths.godotExecutable },
        protocolVersion: this.config.godotMcp.protocolVersion,
        startupTimeoutMs: this.config.godotMcp.startupTimeoutSeconds * 1000,
        requestTimeoutMs: this.config.godotMcp.requestTimeoutSeconds * 1000,
        logger: this.logger,
        label: record.worktree_name,
      });
      await mcp.start();
      this.runtime.get(record.worktree_name).mcp = mcp;
      record.godot_mcp_pid = mcp.pid;
      record.status = "ready";
      record.ready_at = now();
      record.updated_at = now();
      await this.#persist(record);
      await this.logger.info("Worktree pronta.", { worktree: record.worktree_name, lsp_port: record.lsp_port, godot_lsp_port: record.godot_lsp_port, dap_port: record.dap_port, godot_pid: record.godot_pid, godot_mcp_pid: record.godot_mcp_pid });
    } catch (error) {
      record.last_error = error.message;
      await this.#stopRuntime(record, "startup_failed");
      record.status = "failed";
      record.last_error = error.message;
      await this.#persist(record);
      throw error;
    }
  }

  async #onGodotExit(name, code, signal) {
    const record = this.records.get(name);
    if (!record) return;
    const runtime = this.runtime.get(name);
    // Durante shutdown, #stopRuntime e o unico dono do fechamento de streams.
    // Isso evita dois callbacks encerrando os mesmos pipes simultaneamente no
    // Windows enquanto o ChildProcess ainda entrega o evento `close`.
    if (record.status === "stopping" || !record.desired_active) return;
    await Promise.allSettled([
      closeWriteStream(runtime?.stdout),
      closeWriteStream(runtime?.stderr),
    ]);
    record.status = "failed";
    record.last_error = `Godot encerrou: codigo=${code}, sinal=${signal}`;
    record.godot_pid = null;
    await this.#persist(record);
    await this.logger.warn("Godot headless encerrou inesperadamente.", { worktree: name, code, signal });
  }

  async #stopRuntime(record, reason) {
    // Always release Godot AI association before tearing down TODO9 runtime.
    // Idempotent when deactivate already released (including delayed shutdown).
    await this.#releaseGodotAiAssociation(record);

    const runtime = this.runtime.get(record.worktree_name);
    record.status = "stopping";
    record.last_error = null;
    record.directory_released = false;
    await this.#persist(record);

    // Capture os PIDs antes de fechar o cliente MCP. Se o processo pai encerrar
    // primeiro, taskkill /T pode perder descendentes iniciados pelo Godot MCP.
    const mcpPid = runtime?.mcp?.pid || record.godot_mcp_pid;
    const godotPid = runtime?.godot?.pid || record.godot_pid;
    const godotProcessName = path.basename(this.config.paths.godotExecutable);

    try {
      if (runtime?.relay) {
        await runtime.relay.close();
      }

      if (runtime?.projectStarted && runtime?.mcp?.isAlive && runtime.mcp.hasTool("stop_project")) {
        await Promise.race([
          runtime.mcp.callTool("stop_project", {}),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("Timeout aguardando stop_project.")),
            2000,
          )),
        ]).then(() => {
          runtime.projectStarted = false;
        }).catch(async (error) => {
          await this.logger.warn("stop_project nao concluiu; aplicando encerramento forcado.", {
            worktree: record.worktree_name,
            error: error.message,
          });
        });
      }

      if (mcpPid && isPidAlive(mcpPid)) {
        await terminateProcessTree(mcpPid, this.config, this.logger, "godot-mcp");
      }
      if (runtime?.mcp) await runtime.mcp.close();

      if (runtime?.godotAiBridge) {
        await runtime.godotAiBridge.disconnect().catch(() => {});
        runtime.godotAiBridge = null;
      }

      if (godotPid && isPidAlive(godotPid)) {
        await terminateProcessTree(godotPid, this.config, this.logger, record.host_project_path);
      }
      if (runtime?.godot) {
        const godotClosed = await waitForChildProcessClose(
          runtime.godot,
          this.config.service.shutdownTimeoutSeconds * 1000,
        );
        if (!godotClosed) {
          throw new Error(`Callback de encerramento do Godot nao concluiu para PID ${godotPid}.`);
        }
      }

      // Fallback direcionado: encerra somente processos Godot cuja linha de
      // comando ainda referencia o path desta worktree. Isso cobre editores ou
      // jogos descendentes que tenham escapado da arvore original no Windows.
      const residualCleanup = await terminateWindowsProcessesReferencingPath(
        record.host_project_path,
        this.config,
        this.logger,
        [godotProcessName],
      );

      await closeWriteStream(runtime?.stdout);
      await closeWriteStream(runtime?.stderr);
      this.runtime.delete(record.worktree_name);

      const residual = await listWindowsProcessesReferencingPath(
        record.host_project_path,
        this.config,
        [godotProcessName],
      );
      if (residual.length > 0) {
        throw new Error(`Processos residuais ainda referenciam a worktree: ${residual.map((item) => item.pid).join(", ")}`);
      }

      record.godot_pid = null;
      record.godot_mcp_pid = null;
      record.residual_pids = [];
      record.directory_released = true;
      record.status = "stopped";
      record.updated_at = now();
      await this.#persist(record);
      await this.logger.info("Servicos da worktree encerrados e handles GWRM liberados.", {
        worktree: record.worktree_name,
        reason,
        terminated_residual_pids: residualCleanup.terminated,
      });
    } catch (error) {
      const residual = await listWindowsProcessesReferencingPath(
        record.host_project_path,
        this.config,
        [godotProcessName],
      ).catch(() => []);
      record.residual_pids = residual.map((item) => item.pid);
      record.directory_released = false;
      record.status = "failed";
      record.last_error = `Falha ao liberar processos da worktree: ${error.message}`;
      await this.#persist(record);
      await this.logger.error("Falha ao liberar a worktree.", {
        worktree: record.worktree_name,
        reason,
        residual_pids: record.residual_pids,
        error: error.message,
      });
      throw error;
    }
  }

  async #validateProject(hostPath) {
    await access(hostPath);
    await access(path.join(hostPath, "project.godot"));
  }

  async #waitForClassCache(hostPath, child) {
    const cache = path.join(hostPath, ".godot", "global_script_class_cache.cfg");
    const deadline = Date.now() + this.config.sessions.readyTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Godot encerrou antes de gerar o cache de class_name.");
      if (await stat(cache).then((item) => item.isFile()).catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Timeout aguardando global_script_class_cache.cfg.");
  }

  #mapGodotArguments(toolName, args, hostPath) {
    const mapped = {};
    const mapping = {
      scene_path: "scenePath", root_node_type: "rootNodeType", parent_node_path: "parentNodePath",
      node_type: "nodeType", node_name: "nodeName", texture_path: "texturePath", node_path: "nodePath",
      output_path: "outputPath", mesh_item_names: "meshItemNames", new_path: "newPath", file_path: "filePath",
    };
    for (const [key, value] of Object.entries(args)) {
      if (key === "worktree_name") continue;
      mapped[mapping[key] || key] = value;
    }
    const projectTools = new Set(["launch_editor", "run_project", "get_project_info", "create_scene", "add_node", "load_sprite", "export_mesh_library", "save_scene", "get_uid", "update_project_uids"]);
    if (projectTools.has(toolName)) mapped.projectPath = hostPath;
    if (toolName === "list_projects") mapped.directory = hostPath;
    return mapped;
  }

  #recordPath(name) { return path.join(this.config.paths.stateDirectory, `${name}.json`); }
  async #persist(record) {
    record.updated_at = now();
    await writeFile(this.#recordPath(record.worktree_name), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  async #withLock(name, fn) {
    const previous = this.locks.get(name) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(name, queued);
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.locks.get(name) === queued) this.locks.delete(name);
    }
  }

  async #withGodotAiGlobalLock(fn) {
    const previous = this.godotAiGlobalLock || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.godotAiGlobalLock = queued;
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.godotAiGlobalLock === queued) this.godotAiGlobalLock = null;
    }
  }
}
