import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GodotAiBridge, GODOT_AI_BRIDGE_CODES } from "../src/godot-ai-bridge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakePath = path.join(root, "tests", "fixtures", "fake-godot-ai-mcp.mjs");
const logger = { info: async () => {}, warn: async () => {}, error: async () => {} };

function attachOptions(overrides = {}) {
  return {
    httpPort: 18000,
    wsPort: 19500,
    command: process.execPath,
    args: [fakePath],
    cwd: root,
    env: process.env,
    logger,
    label: "test-bridge",
    startupTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

async function withBridge(fn) {
  const bridge = new GodotAiBridge();
  try {
    return await fn(bridge);
  } finally {
    await bridge.disconnect();
  }
}

test("attach against fake lists sessions without selecting an implicit current session", async () => {
  await withBridge(async (bridge) => {
    const attached = await bridge.attach(attachOptions());
    assert.equal(attached.ok, true);
    assert.equal(attached.session_id, null, "must not pick an implicit current session");
    assert.ok(Array.isArray(attached.sessions));
    assert.equal(attached.sessions.length, 2);
    const ids = attached.sessions.map((s) => s.session_id).sort();
    assert.deepEqual(ids, ["wt-a@aaaaaaaaaaaaaaaa", "wt-b@bbbbbbbbbbbbbbbb"]);
    assert.equal(bridge.isConnected, true);
  });
});

test("callTool requires explicit session_id (GODOT_AI_SESSION_REQUIRED)", async () => {
  await withBridge(async (bridge) => {
    const attached = await bridge.attach(attachOptions());
    assert.equal(attached.ok, true);

    const missing = await bridge.callTool({ name: "echo_session", arguments: { payload: 1 } });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, GODOT_AI_BRIDGE_CODES.SESSION_REQUIRED);

    const empty = await bridge.callTool({ session_id: "  ", name: "echo_session", arguments: {} });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, GODOT_AI_BRIDGE_CODES.SESSION_REQUIRED);

    const nullId = await bridge.callTool({ session_id: null, name: "echo_session", arguments: {} });
    assert.equal(nullId.ok, false);
    assert.equal(nullId.code, GODOT_AI_BRIDGE_CODES.SESSION_REQUIRED);
  });
});

test("explicit session_id routing: two sessions without cross-talk", async () => {
  await withBridge(async (bridge) => {
    const attached = await bridge.attach(attachOptions());
    assert.equal(attached.ok, true);
    const [sessionA, sessionB] = attached.sessions;
    assert.notEqual(sessionA.session_id, sessionB.session_id);

    const echoA = await bridge.callTool({
      session_id: sessionA.session_id,
      name: "echo_session",
      arguments: { payload: "from-a" },
    });
    assert.equal(echoA.ok, true);
    assert.equal(echoA.result.session_id, sessionA.session_id);
    assert.equal(echoA.result.marker, "A");
    assert.equal(echoA.result.echo, "from-a");

    const mutateA = await bridge.callTool({
      session_id: sessionA.session_id,
      name: "mutate_marker",
      arguments: { marker: "A-mutated" },
    });
    assert.equal(mutateA.ok, true);
    assert.equal(mutateA.result.marker, "A-mutated");
    assert.equal(mutateA.result.session_id, sessionA.session_id);

    const echoB = await bridge.callTool({
      session_id: sessionB.session_id,
      name: "echo_session",
      arguments: { payload: "from-b" },
    });
    assert.equal(echoB.ok, true);
    assert.equal(echoB.result.session_id, sessionB.session_id);
    assert.equal(echoB.result.marker, "B", "session B must not inherit session A mutations");
    assert.equal(echoB.result.echo, "from-b");

    const reA = await bridge.callTool({
      session_id: sessionA.session_id,
      name: "echo_session",
      arguments: {},
    });
    assert.equal(reA.ok, true);
    assert.equal(reA.result.marker, "A-mutated");
    assert.equal(reA.result.session_id, sessionA.session_id);
  });
});

test("session_activate is not used for routing", async () => {
  await withBridge(async (bridge) => {
    const attached = await bridge.attach(attachOptions());
    assert.equal(attached.ok, true);
    const sessionId = attached.sessions[0].session_id;

    const blocked = await bridge.callTool({
      session_id: sessionId,
      name: "session_activate",
      arguments: {},
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, GODOT_AI_BRIDGE_CODES.TOOL_FAILED);
    assert.match(blocked.message, /session_activate is not permitted/i);

    // Normal tool path must still inject session_id top-level without activate.
    const echo = await bridge.callTool({
      session_id: sessionId,
      name: "editor_state",
      arguments: {},
    });
    assert.equal(echo.ok, true);
    assert.equal(echo.result.session_id, sessionId);
  });
});

test("listSessions does not change routing state and returns both sessions", async () => {
  await withBridge(async (bridge) => {
    const attached = await bridge.attach(attachOptions());
    assert.equal(attached.ok, true);

    const listed = await bridge.listSessions();
    assert.equal(listed.ok, true);
    assert.equal(listed.sessions.length, 2);
    assert.equal(listed.count, 2);
    for (const session of listed.sessions) {
      assert.equal(session.is_active, false);
    }
  });
});

test("disconnect makes subsequent callTool fail with GODOT_AI_DISCONNECTED", async () => {
  const bridge = new GodotAiBridge();
  const attached = await bridge.attach(attachOptions());
  assert.equal(attached.ok, true);
  const sessionId = attached.sessions[0].session_id;

  const closed = await bridge.disconnect();
  assert.equal(closed.ok, true);
  assert.equal(bridge.isConnected, false);

  const after = await bridge.callTool({
    session_id: sessionId,
    name: "echo_session",
    arguments: {},
  });
  assert.equal(after.ok, false);
  assert.equal(after.code, GODOT_AI_BRIDGE_CODES.DISCONNECTED);

  const listed = await bridge.listSessions();
  assert.equal(listed.ok, false);
  assert.equal(listed.code, GODOT_AI_BRIDGE_CODES.DISCONNECTED);
});

test("attach transport failure returns structured GODOT_AI_ATTACH_FAILED", async () => {
  await withBridge(async (bridge) => {
    const failed = await bridge.attach(attachOptions({
      command: process.execPath,
      args: [path.join(root, "tests", "fixtures", "does-not-exist-fake-godot-ai.mjs")],
    }));
    assert.equal(failed.ok, false);
    assert.equal(failed.code, GODOT_AI_BRIDGE_CODES.ATTACH_FAILED);
    assert.equal(bridge.isConnected, false);
  });
});

test("default attach argv pin matches spike-proven godot-ai==4.1.0 command", () => {
  const built = GodotAiBridge.buildDefaultAttachCommand(8000, 9500);
  assert.equal(built.command, "uvx");
  assert.deepEqual(built.args, [
    "--isolated",
    "--no-config",
    "--no-env-file",
    "--no-sources",
    "--no-build",
    "--from",
    "godot-ai==4.1.0",
    "godot-ai",
    "attach",
    "--port",
    "8000",
    "--ws-port",
    "9500",
  ]);
});

test("callTool always injects session_id top-level even if arguments omit it", async () => {
  await withBridge(async (bridge) => {
    const attached = await bridge.attach(attachOptions());
    assert.equal(attached.ok, true);
    const sessionId = attached.sessions[1].session_id;

    const result = await bridge.callTool({
      session_id: sessionId,
      name: "echo_session",
      arguments: { payload: { nested: true } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.session_id, sessionId);
    assert.equal(result.result.session_id, sessionId);
    assert.equal(result.result.marker, "B");
  });
});
