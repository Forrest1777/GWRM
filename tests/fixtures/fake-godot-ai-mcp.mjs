import readline from "node:readline";

/**
 * Fake Godot AI MCP (stdio JSON-RPC) for GodotAiBridge unit tests.
 * Supports two isolated sessions and rejects session_activate as a routing path.
 */

const SESSION_A = {
  session_id: "wt-a@aaaaaaaaaaaaaaaa",
  name: "wt-a",
  godot_version: "4.7.2-stable",
  project_path: "C:/workspace/.worktrees/wt-a",
  plugin_version: "4.0.4",
  server_version: "4.0.4",
  protocol_version: 1,
  current_scene: "",
  play_state: "stopped",
  readiness: "ready",
  editor_pid: 1001,
  server_launch_mode: "attach",
  connected_at: "2026-01-01T00:00:00.000Z",
  last_seen: "2026-01-01T00:00:00.000Z",
  is_active: false,
};

const SESSION_B = {
  session_id: "wt-b@bbbbbbbbbbbbbbbb",
  name: "wt-b",
  godot_version: "4.7.2-stable",
  project_path: "C:/workspace/.worktrees/wt-b",
  plugin_version: "4.0.4",
  server_version: "4.0.4",
  protocol_version: 1,
  current_scene: "",
  play_state: "stopped",
  readiness: "ready",
  editor_pid: 1002,
  server_launch_mode: "attach",
  connected_at: "2026-01-01T00:00:00.000Z",
  last_seen: "2026-01-01T00:00:00.000Z",
  is_active: false,
};

const tools = [
  "session_manage",
  "session_activate",
  "editor_state",
  "echo_session",
  "mutate_marker",
];

/** @type {Map<string, { marker: string, calls: number }>} */
const sessionState = new Map([
  [SESSION_A.session_id, { marker: "A", calls: 0 }],
  [SESSION_B.session_id, { marker: "B", calls: 0 }],
]);

/** @type {Array<{ name: string, arguments: object }>} */
const callLog = [];

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function okResult(id, payload) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  });
}

function errResult(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      structuredContent: { ok: false, code, message },
      content: [{ type: "text", text: message }],
    },
  });
}

function listSessionsPayload() {
  return {
    sessions: [
      { ...SESSION_A, is_active: false },
      { ...SESSION_B, is_active: false },
    ],
    count: 2,
    exclude_domains: [],
  };
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.id === null) return;

  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-godot-ai", version: "4.0.4" },
      },
    });
    return;
  }

  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
      },
    });
    return;
  }

  if (request.method === "tools/call") {
    const name = request.params?.name;
    const args = request.params?.arguments && typeof request.params.arguments === "object"
      ? { ...request.params.arguments }
      : {};
    callLog.push({ name, arguments: args });

    if (name === "session_activate") {
      errResult(
        request.id,
        "FAKE_SESSION_ACTIVATE_FORBIDDEN",
        "fake-godot-ai rejects session_activate; use explicit session_id routing",
      );
      return;
    }

    if (name === "session_manage") {
      const op = args.op;
      if (op === "list") {
        okResult(request.id, listSessionsPayload());
        return;
      }
      errResult(request.id, "FAKE_UNKNOWN_OP", `unknown session_manage op: ${op}`);
      return;
    }

    const sessionId = args.session_id;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      errResult(request.id, "FAKE_SESSION_REQUIRED", "session_id is required");
      return;
    }

    const state = sessionState.get(sessionId);
    if (!state) {
      errResult(request.id, "FAKE_SESSION_NOT_FOUND", `unknown session_id: ${sessionId}`);
      return;
    }

    state.calls += 1;

    if (name === "echo_session") {
      okResult(request.id, {
        session_id: sessionId,
        marker: state.marker,
        calls: state.calls,
        echo: args.payload ?? null,
      });
      return;
    }

    if (name === "mutate_marker") {
      if (typeof args.marker === "string") state.marker = args.marker;
      okResult(request.id, {
        session_id: sessionId,
        marker: state.marker,
        calls: state.calls,
      });
      return;
    }

    if (name === "editor_state") {
      okResult(request.id, {
        session_id: sessionId,
        marker: state.marker,
        readiness: "ready",
        project_path: sessionId.startsWith("wt-a") ? SESSION_A.project_path : SESSION_B.project_path,
      });
      return;
    }

    okResult(request.id, {
      session_id: sessionId,
      name,
      marker: state.marker,
      args,
    });
    return;
  }

  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
