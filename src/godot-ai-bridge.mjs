import { StdioMcpClient } from "./stdio-mcp-client.mjs";
import { GODOT_AI_PACKAGE_SPEC } from "./godot-ai-policy.mjs";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const CODES = Object.freeze({
  SESSION_REQUIRED: "GODOT_AI_SESSION_REQUIRED",
  DISCONNECTED: "GODOT_AI_DISCONNECTED",
  ATTACH_FAILED: "GODOT_AI_ATTACH_FAILED",
  TRANSPORT: "GODOT_AI_TRANSPORT_ERROR",
  TOOL_FAILED: "GODOT_AI_TOOL_FAILED",
  INVALID_RESPONSE: "GODOT_AI_INVALID_RESPONSE",
  NOT_ATTACHED: "GODOT_AI_NOT_ATTACHED",
});

function noopLogger() {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
  };
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
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return null;
}

function extractStructured(result) {
  if (!result || typeof result !== "object") return null;
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  if (result.structured_content && typeof result.structured_content === "object") return result.structured_content;
  for (const block of result.content || []) {
    if (block?.type !== "text") continue;
    const parsed = tryParseJsonText(block.text);
    if (parsed !== null) return parsed;
  }
  return null;
}

function sanitizeMessage(value) {
  if (value == null) return "unknown error";
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, "$1[REDACTED]")
    .replace(/(token["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, "$1[REDACTED]")
    .slice(0, 2000);
}

function failure(code, message, extra = {}) {
  const out = {
    ok: false,
    code,
    message: sanitizeMessage(message),
  };
  if (extra.session_id !== undefined && extra.session_id !== null && extra.session_id !== "") {
    out.session_id = String(extra.session_id);
  }
  return out;
}

function success(payload = {}) {
  return { ok: true, ...payload };
}

function buildDefaultAttachArgs(httpPort, wsPort) {
  return [
    "--isolated",
    "--no-config",
    "--no-env-file",
    "--no-sources",
    "--no-build",
    "--from",
    GODOT_AI_PACKAGE_SPEC,
    "godot-ai",
    "attach",
    "--port",
    String(httpPort),
    "--ws-port",
    String(wsPort),
  ];
}

function normalizeSessions(payload) {
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  if (Array.isArray(payload)) return payload;
  return [];
}

/**
 * Exclusive GWRM client for Godot AI MCP attach.
 * Protocol + error mapping + explicit session_id routing only.
 * Does not own lifecycle, ports assignment, SessionManager, or Kanban.
 */
export class GodotAiBridge {
  constructor(dependencies = {}) {
    this.clientFactory = dependencies.clientFactory || ((options) => new StdioMcpClient(options));
    this.client = null;
    this.connected = false;
    this.logger = noopLogger();
    this.label = null;
    this.lastAttachMeta = null;
  }

  static get codes() {
    return CODES;
  }

  static buildDefaultAttachCommand(httpPort, wsPort) {
    return {
      command: "uvx",
      args: buildDefaultAttachArgs(httpPort, wsPort),
    };
  }

  /**
   * Attach to Godot AI MCP over stdio.
   * After initialize + tools/list, lists sessions via session_manage op=list.
   * Never calls session_activate and never picks an implicit current session.
   *
   * @returns {Promise<{ok:true, session_id:null, sessions:array}|{ok:false, code:string, message:string}>}
   */
  async attach(options = {}) {
    if (this.connected && this.client) {
      await this.disconnect().catch(() => {});
    }

    const httpPort = options.httpPort;
    const wsPort = options.wsPort;
    const logger = options.logger || noopLogger();
    const label = options.label ?? null;
    this.logger = logger;
    this.label = label;

    const defaults = GodotAiBridge.buildDefaultAttachCommand(httpPort ?? 8000, wsPort ?? 9500);
    const command = options.command || defaults.command;
    const args = Array.isArray(options.args) ? options.args : defaults.args;
    const cwd = options.cwd || process.cwd();
    const env = options.env || process.env;
    const protocolVersion = options.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    const startupTimeoutMs = Number.isInteger(options.startupTimeoutMs)
      ? options.startupTimeoutMs
      : DEFAULT_STARTUP_TIMEOUT_MS;
    const requestTimeoutMs = Number.isInteger(options.requestTimeoutMs)
      ? options.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;

    let client = null;
    try {
      client = this.clientFactory({
        command,
        args,
        cwd,
        env,
        protocolVersion,
        startupTimeoutMs,
        requestTimeoutMs,
        logger,
        label,
        serverName: "Godot AI",
      });
      await client.start();

      if (!client.hasTool("session_manage")) {
        await client.close().catch(() => {});
        this.client = null;
        this.connected = false;
        return failure(CODES.ATTACH_FAILED, "Godot AI attach did not advertise session_manage.");
      }

      this.client = client;
      this.connected = true;
      this.lastAttachMeta = {
        httpPort: httpPort ?? null,
        wsPort: wsPort ?? null,
        command,
        args,
      };

      const listed = await this.#listSessionsInternal();
      if (!listed.ok) {
        await this.disconnect().catch(() => {});
        return listed;
      }

      // Never auto-select a current session. Consumers must pass session_id explicitly.
      return success({
        session_id: null,
        sessions: listed.sessions,
      });
    } catch (error) {
      if (client) await client.close().catch(() => {});
      this.client = null;
      this.connected = false;
      return failure(CODES.ATTACH_FAILED, error);
    }
  }

  /**
   * Call a Godot AI tool with an explicit session_id (required).
   * session_id is always injected as a top-level tool argument.
   */
  async callTool({ session_id, name, arguments: toolArgs } = {}) {
    if (!this.connected || !this.client || this.client.closed || !this.client.isAlive) {
      return failure(CODES.DISCONNECTED, "Godot AI bridge is disconnected.");
    }

    if (typeof session_id !== "string" || !session_id.trim()) {
      return failure(CODES.SESSION_REQUIRED, "session_id is required for Godot AI tool calls.");
    }

    if (typeof name !== "string" || !name.trim()) {
      return failure(CODES.TOOL_FAILED, "tool name is required.", { session_id });
    }

    if (name === "session_activate") {
      return failure(
        CODES.TOOL_FAILED,
        "session_activate is not permitted; pass session_id explicitly on each call.",
        { session_id },
      );
    }

    const baseArgs = toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
      ? { ...toolArgs }
      : {};
    // Explicit routing only: always overwrite any nested/stale session_id.
    const args = { ...baseArgs, session_id };

    try {
      const raw = await this.client.callTool(name, args);
      if (raw?.isError) {
        const structured = extractStructured(raw);
        const message = structured?.message
          || (Array.isArray(raw.content) ? raw.content.map((b) => b?.text).filter(Boolean).join(" ") : null)
          || "Godot AI tool returned isError.";
        return failure(structured?.code || CODES.TOOL_FAILED, message, { session_id });
      }
      const structured = extractStructured(raw);
      return success({
        session_id,
        name,
        result: structured ?? raw ?? null,
        raw,
      });
    } catch (error) {
      if (this.client?.closed || !this.client?.isAlive) {
        this.connected = false;
        return failure(CODES.DISCONNECTED, error, { session_id });
      }
      return failure(CODES.TRANSPORT, error, { session_id });
    }
  }

  /**
   * List sessions without changing routing state (no session_activate).
   */
  async listSessions() {
    if (!this.connected || !this.client || this.client.closed || !this.client.isAlive) {
      return failure(CODES.DISCONNECTED, "Godot AI bridge is disconnected.");
    }
    return await this.#listSessionsInternal();
  }

  async disconnect() {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) {
      try {
        await client.close();
      } catch (error) {
        await this.logger.warn?.("Failed to close Godot AI client.", {
          component: "godot_ai_bridge",
          error: sanitizeMessage(error),
        });
      }
    }
    return success({ disconnected: true });
  }

  get isConnected() {
    return Boolean(this.connected && this.client && this.client.isAlive && !this.client.closed);
  }

  async #listSessionsInternal() {
    try {
      const raw = await this.client.callTool("session_manage", { op: "list" });
      if (raw?.isError) {
        const structured = extractStructured(raw);
        return failure(
          structured?.code || CODES.TOOL_FAILED,
          structured?.message || "session_manage list failed.",
        );
      }
      const structured = extractStructured(raw);
      if (!structured) {
        return failure(CODES.INVALID_RESPONSE, "session_manage list returned no structured payload.");
      }
      const sessions = normalizeSessions(structured);
      return success({
        sessions,
        count: Number.isInteger(structured.count) ? structured.count : sessions.length,
        exclude_domains: Array.isArray(structured.exclude_domains) ? structured.exclude_domains : [],
      });
    } catch (error) {
      if (this.client?.closed || !this.client?.isAlive) {
        this.connected = false;
        return failure(CODES.DISCONNECTED, error);
      }
      return failure(CODES.TRANSPORT, error);
    }
  }
}

export { CODES as GODOT_AI_BRIDGE_CODES };
