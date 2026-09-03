import { StdioMcpClient } from "./stdio-mcp-client.mjs";
import { listWindowsProcessesReferencingPath } from "./process-utils.mjs";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clampInteger(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

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
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function extractStructured(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  if (result?.structured_content && typeof result.structured_content === "object") return result.structured_content;
  for (const block of result?.content || []) {
    if (block?.type !== "text") continue;
    const parsed = tryParseJsonText(block.text);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeWindows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.windows)) return payload.windows;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function publicWindow(window) {
  return {
    window_id: Number(window.window_id),
    pid: Number(window.pid),
    app_name: window.app_name ?? null,
    title: window.title ?? "",
    bounds: window.bounds ?? null,
    z_index: Number.isInteger(window.z_index) ? window.z_index : null,
    is_on_screen: window.is_on_screen ?? null,
    on_current_space: window.on_current_space ?? null,
  };
}

const REQUIRED_CUA_TOOLS = [
  "list_windows",
  "get_window_state",
  "click",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
];

export class ComputerUseService {
  constructor(config, sessionManager, logger, dependencies = {}) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.client = null;
    this.state = "new";
    this.lastError = null;
    this.desktopReady = false;
    this.startedAt = null;
    this.processLister = dependencies.processLister || listWindowsProcessesReferencingPath;
    this.sleep = dependencies.sleep || sleep;
    this.clientFactory = dependencies.clientFactory || ((options) => new StdioMcpClient(options));
  }

  async init() {
    if (!this.config.computerUse.enabled) {
      this.state = "disabled";
      return this.getStatus();
    }

    this.state = "starting";
    this.lastError = null;
    try {
      const env = {
        ...process.env,
        CUA_DRIVER_PERMISSION_MODE: this.config.computerUse.permissionMode,
      };
      if (this.config.computerUse.permissionMode === "bounded") {
        env.CUA_DRIVER_CAPABILITY_MANIFEST_FILE = this.config.computerUse.capabilityManifestFile;
        env.CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED = "1";
      }
      const client = this.clientFactory({
        command: this.config.computerUse.command,
        args: this.config.computerUse.args,
        cwd: this.config.appRoot,
        env,
        protocolVersion: this.config.computerUse.protocolVersion,
        startupTimeoutMs: this.config.computerUse.startupTimeoutSeconds * 1000,
        requestTimeoutMs: this.config.computerUse.requestTimeoutSeconds * 1000,
        logger: this.logger,
        label: null,
        serverName: "Cua Driver",
      });
      await client.start();
      this.client = client;
      for (const tool of REQUIRED_CUA_TOOLS) {
        if (!client.hasTool(tool)) throw new Error(`Cua Driver nao oferece a tool obrigatoria '${tool}'.`);
      }
      const discovery = await this.#call("list_windows", { on_screen_only: false });
      const discoveryPayload = extractStructured(discovery);
      this.desktopReady = discoveryPayload !== null;
      this.state = "ready";
      this.startedAt = new Date().toISOString();
      await this.logger.info("Computer Use pronto.", {
        component: "computer_use",
        cua_pid: client.pid,
        desktop_ready: this.desktopReady,
        permission_mode: this.config.computerUse.permissionMode,
      });
      return this.getStatus();
    } catch (error) {
      this.state = "unavailable";
      this.desktopReady = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.client) await this.client.close().catch(() => {});
      this.client = null;
      const log = this.config.computerUse.required ? this.logger.error.bind(this.logger) : this.logger.warn.bind(this.logger);
      await log("Computer Use indisponivel.", { component: "computer_use", error: this.lastError });
      if (this.config.computerUse.required) throw error;
      return this.getStatus();
    }
  }

  getStatus() {
    return {
      enabled: this.config.computerUse.enabled,
      required: this.config.computerUse.required,
      state: this.state,
      ready: this.state === "ready" && Boolean(this.client?.isAlive),
      desktop_ready: this.desktopReady,
      cua_driver_pid: this.client?.pid ?? null,
      permission_mode: this.config.computerUse.permissionMode,
      semantic_first: true,
      default_include_screenshot: false,
      started_at: this.startedAt,
      last_error: this.lastError,
    };
  }

  async shutdown() {
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(async (error) => {
      await this.logger.warn("Falha encerrando Cua Driver.", { component: "computer_use", error: error.message });
    });
    this.state = this.config.computerUse.enabled ? "stopped" : "disabled";
    this.desktopReady = false;
  }

  async listWindows(worktreeName, options = {}) {
    await this.#ensureReady();
    const pids = await this.#resolveAllowedPids(worktreeName);
    const windows = [];
    for (const pid of pids) {
      const result = await this.#call("list_windows", {
        pid,
        on_screen_only: options.onScreenOnly === true,
      });
      windows.push(...normalizeWindows(extractStructured(result)).map(publicWindow));
    }
    const unique = new Map();
    for (const window of windows) {
      if (Number.isInteger(window.window_id) && window.window_id > 0) unique.set(`${window.pid}:${window.window_id}`, window);
    }
    return {
      worktree_name: worktreeName,
      windows: [...unique.values()].sort((a, b) => (b.z_index ?? -1) - (a.z_index ?? -1)),
    };
  }

  async waitForWindow(worktreeName, options = {}) {
    const timeoutSeconds = clampInteger(options.timeoutSeconds, this.config.computerUse.waitTimeoutSeconds, 1, this.config.computerUse.maxWaitTimeoutSeconds);
    const deadline = Date.now() + timeoutSeconds * 1000;
    const titleContains = String(options.titleContains || "").toLowerCase();
    let last = { worktree_name: worktreeName, windows: [] };
    do {
      last = await this.listWindows(worktreeName, { onScreenOnly: options.onScreenOnly === true });
      const matched = titleContains
        ? last.windows.filter((window) => String(window.title || "").toLowerCase().includes(titleContains))
        : last.windows;
      if (matched.length > 0) {
        return { worktree_name: worktreeName, matched: true, window: matched[0], windows: matched };
      }
      await this.sleep(this.config.computerUse.waitPollMilliseconds);
    } while (Date.now() < deadline);
    return { worktree_name: worktreeName, matched: false, timeout_seconds: timeoutSeconds, windows: last.windows };
  }

  async inspectWindow(worktreeName, windowId, options = {}) {
    const target = await this.#resolveTarget(worktreeName, windowId);
    return await this.#inspectTarget(worktreeName, target, options);
  }

  async captureWindow(worktreeName, windowId, options = {}) {
    const target = await this.#resolveTarget(worktreeName, windowId);
    const result = await this.#call("get_window_state", {
      pid: target.pid,
      window_id: target.window_id,
      include_accessibility_tree: false,
      include_screenshot: true,
      max_dimension: clampInteger(options.maxDimension, this.config.computerUse.maxImageDimension, 64, 4096),
    });
    return result;
  }

  async waitForElement(worktreeName, windowId, query, options = {}) {
    if (!String(query || "").trim()) throw new Error("query e obrigatoria para gui_wait_for_element.");
    const timeoutSeconds = clampInteger(options.timeoutSeconds, this.config.computerUse.waitTimeoutSeconds, 1, this.config.computerUse.maxWaitTimeoutSeconds);
    const deadline = Date.now() + timeoutSeconds * 1000;
    const target = await this.#resolveTarget(worktreeName, windowId);
    let last = null;
    do {
      last = await this.#inspectTarget(worktreeName, target, {
        query,
        maxElements: options.maxElements,
        maxDepth: options.maxDepth,
      });
      const elements = Array.isArray(last.state?.elements) ? last.state.elements : [];
      if (elements.length > 0) return { ...last, matched: true };
      await this.sleep(this.config.computerUse.waitPollMilliseconds);
    } while (Date.now() < deadline);
    return { ...last, matched: false, timeout_seconds: timeoutSeconds };
  }

  async #inspectTarget(worktreeName, target, options = {}) {
    const args = {
      pid: target.pid,
      window_id: target.window_id,
      include_screenshot: false,
      include_accessibility_tree: true,
      max_elements: clampInteger(options.maxElements, this.config.computerUse.maxSemanticElements, 1, 2000),
      max_depth: clampInteger(options.maxDepth, this.config.computerUse.maxSemanticDepth, 1, 25),
    };
    if (options.query) args.query = String(options.query);
    const result = await this.#call("get_window_state", args);
    const structured = extractStructured(result);
    return {
      worktree_name: worktreeName,
      window: target,
      state: structured ?? { text: this.#textFallback(result) },
      screenshot_included: false,
    };
  }

  async click(worktreeName, windowId, args = {}) {
    return await this.#action("click", worktreeName, windowId, args, [
      "element_token", "element_index", "snapshot_id", "x", "y", "button", "count", "action", "modifier",
    ]);
  }

  async typeText(worktreeName, windowId, args = {}) {
    if (typeof args.text !== "string") throw new Error("text e obrigatorio para gui_type_text.");
    return await this.#action("type_text", worktreeName, windowId, args, [
      "text", "element_token", "element_index", "snapshot_id", "x", "y",
    ]);
  }

  async pressKey(worktreeName, windowId, args = {}) {
    if (!String(args.key || "").trim()) throw new Error("key e obrigatoria para gui_press_key.");
    return await this.#action("press_key", worktreeName, windowId, args, [
      "key", "modifiers", "element_token", "element_index", "snapshot_id", "x", "y",
    ]);
  }

  async hotkey(worktreeName, windowId, args = {}) {
    if (!Array.isArray(args.keys) || args.keys.length < 2) throw new Error("keys deve conter ao menos duas teclas para gui_hotkey.");
    return await this.#action("hotkey", worktreeName, windowId, args, [
      "keys", "element_token", "element_index", "snapshot_id", "x", "y",
    ]);
  }

  async scroll(worktreeName, windowId, args = {}) {
    if (!String(args.direction || "").trim()) throw new Error("direction e obrigatoria para gui_scroll.");
    return await this.#action("scroll", worktreeName, windowId, args, [
      "direction", "amount", "by", "element_token", "element_index", "snapshot_id", "x", "y",
    ]);
  }

  async #action(tool, worktreeName, windowId, source, allowedKeys) {
    const target = await this.#resolveTarget(worktreeName, windowId);
    const args = {
      pid: target.pid,
      window_id: target.window_id,
      delivery_mode: source.delivery_mode === "foreground" ? "foreground" : "background",
    };
    for (const key of allowedKeys) {
      if (source[key] !== undefined) args[key] = source[key];
    }
    const result = await this.#call(tool, args);
    await this.logger.info("Computer Use action concluida.", {
      component: "computer_use",
      worktree: worktreeName,
      action: tool,
      pid: target.pid,
      window_id: target.window_id,
      delivery_mode: args.delivery_mode,
    });
    return result;
  }

  async #resolveTarget(worktreeName, windowId) {
    const numericWindowId = Number(windowId);
    if (!Number.isInteger(numericWindowId) || numericWindowId <= 0) throw new Error("window_id invalido.");
    const listed = await this.listWindows(worktreeName, { onScreenOnly: false });
    const target = listed.windows.find((window) => window.window_id === numericWindowId);
    if (!target) throw new Error(`Janela ${numericWindowId} nao pertence a um processo Godot grafico autorizado da worktree ${worktreeName}.`);
    return target;
  }

  async #resolveAllowedPids(worktreeName) {
    const session = this.sessionManager.getStatus(worktreeName);
    if (!session?.registered) throw new Error(`Worktree ${worktreeName} nao esta registrada no GWRM.`);
    const processes = await this.processLister(session.host_project_path, this.config, []);
    const persistentPid = Number(session.godot_pid);
    const allowed = processes.filter((item) => {
      const name = String(item.name || "").toLowerCase();
      const command = String(item.command_line || "").toLowerCase();
      if (!name.includes("godot")) return false;
      if (item.pid === persistentPid) return false;
      if (command.includes("--headless")) return false;
      return true;
    });
    return [...new Set(allowed.map((item) => item.pid))];
  }

  async #ensureReady() {
    if (this.state !== "ready" || !this.client?.isAlive) {
      throw new Error(`Computer Use nao esta pronto (state=${this.state}${this.lastError ? `, erro=${this.lastError}` : ""}).`);
    }
  }

  async #call(tool, args) {
    await this.#ensureReadyUnlessStarting();
  
    if (tool !== "start_session") {
      const sessionResult = await this.client.callTool("start_session", {});
      if (sessionResult?.isError) {
        throw new Error(
          this.#textFallback(sessionResult) ||
          "Cua Driver rejected start_session."
        );
      }
    }
  
    const result = await this.client.callTool(tool, args);
  
    if (result?.isError) {
      throw new Error(
        this.#textFallback(result) ||
        `Cua Driver rejected ${tool}.`
      );
    }
  
    return result;
  }

  async #ensureReadyUnlessStarting() {
    if (this.client?.isAlive && (this.state === "starting" || this.state === "ready")) return;
    await this.#ensureReady();
  }

  #textFallback(result) {
    return (result?.content || [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .slice(-12000);
  }
}
