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

function now() { return new Date().toISOString(); }
function cloneState(state) { return JSON.parse(JSON.stringify(state)); }

async function closeWriteStream(stream, timeoutMs = 3000) {
  if (!stream || stream.closed || stream.destroyed) return;
  stream.end();
  await Promise.race([
    once(stream, "close").catch(() => []),
    once(stream, "finish").catch(() => []),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout fechando stream de log.")), timeoutMs)),
  ]);
  if (!stream.closed && !stream.destroyed) stream.destroy();
}

export class SessionManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.records = new Map();
    this.runtime = new Map();
    this.locks = new Map();
    this.reconcileTimer = null;
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
      return this.getStatus(name);
    });
  }

  async ensureWorktree(name, source = "ensure") {
    return await this.activateWorktree(name, source);
  }

  async deactivateWorktree(name, source = "mcp") {
    return await this.#withLock(name, async () => {
      const record = this.records.get(name);
      if (!record) return { worktree_name: name, desired_active: false, status: "not_registered" };
      record.desired_active = false;
      const shutdownDelay = this.config.sessions.inactiveShutdownDelaySeconds ?? 0;
      record.shutdown_not_before = shutdownDelay > 0
        ? new Date(Date.now() + shutdownDelay * 1000).toISOString()
        : null;
      record.last_requested_at = now();
      record.last_request_source = source;
      await this.#persist(record);
      if (shutdownDelay === 0) await this.#stopRuntime(record, "deactivated");
      return this.getStatus(name);
    });
  }

  getStatus(name) {
    const record = this.records.get(name);
    if (!record) return null;
    const runtime = this.runtime.get(name);
    return {
      ...cloneState(record),
      lsp: {
        host: this.config.godot.lspHostForHermes,
        port: record.lsp_port,
        godot_internal_port: record.godot_lsp_port,
        ready: record.status === "ready" && Boolean(record.lsp_port),
      },
      dap: { host: this.config.godot.lspHostForHermes, port: record.dap_port },
      godot_mcp_ready: Boolean(runtime?.mcp?.isAlive),
    };
  }

  listStatuses() {
    return [...this.records.keys()].sort().map((name) => this.getStatus(name));
  }

  async callGodotTool(name, toolName, args) {
    const session = await this.ensureWorktree(name, `tool:${toolName}`);
    const runtime = this.runtime.get(name);
    if (!runtime?.mcp?.isAlive) throw new Error(`Godot MCP dedicado de ${name} nao esta pronto.`);
    if (!runtime.mcp.hasTool(toolName)) throw new Error(`A versao instalada do Godot MCP nao oferece a tool '${toolName}'.`);
    const upstreamArgs = this.#mapGodotArguments(toolName, args, session.host_project_path);
    return await runtime.mcp.callTool(toolName, upstreamArgs);
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
    };
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

    await this.#stopRuntime(record, "restart_before_start");
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
    this.runtime.set(record.worktree_name, { godot, stdout, stderr, mcp: null, relay: null });
    godot.once("close", (code, signal) => this.#onGodotExit(record.worktree_name, code, signal));

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
    if (runtime) {
      runtime.stdout?.end();
      runtime.stderr?.end();
    }
    if (record.status === "stopping" || !record.desired_active) return;
    record.status = "failed";
    record.last_error = `Godot encerrou: codigo=${code}, sinal=${signal}`;
    record.godot_pid = null;
    await this.#persist(record);
    await this.logger.warn("Godot headless encerrou inesperadamente.", { worktree: name, code, signal });
  }

  async #stopRuntime(record, reason) {
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

      if (runtime?.mcp?.isAlive && runtime.mcp.hasTool("stop_project")) {
        await Promise.race([
          runtime.mcp.callTool("stop_project", {}),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("Timeout aguardando stop_project.")),
            2000,
          )),
        ]).catch(async (error) => {
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

      if (godotPid && isPidAlive(godotPid)) {
        await terminateProcessTree(godotPid, this.config, this.logger, record.host_project_path);
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
}
