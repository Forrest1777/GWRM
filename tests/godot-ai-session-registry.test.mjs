import test from "node:test";
import assert from "node:assert/strict";
import {
  GODOT_AI_SESSION_CONFLICT,
  GODOT_AI_SESSION_MISS,
  GODOT_AI_SESSION_NOT_USABLE,
  GodotAiSessionRegistry,
} from "../src/godot-ai-session-registry.mjs";

function bindReady(registry, overrides = {}) {
  return registry.bind({
    worktree_name: "wt_a",
    runtime_pid: 1001,
    session_id: "sess_a",
    http_port: 8001,
    ws_port: 9501,
    observed_state: "session_ready",
    ...overrides,
  });
}

test("bind/get isolate two worktrees without cross-talk", () => {
  const registry = new GodotAiSessionRegistry();
  const a = bindReady(registry, {
    worktree_name: "wt_a",
    runtime_pid: 11,
    session_id: "sess_a",
    http_port: 8001,
    ws_port: 9501,
  });
  const b = bindReady(registry, {
    worktree_name: "wt_b",
    runtime_pid: 22,
    session_id: "sess_b",
    http_port: 8002,
    ws_port: 9502,
  });

  assert.equal(a.worktree_name, "wt_a");
  assert.equal(b.worktree_name, "wt_b");
  assert.equal(a.generation, 1);
  assert.equal(b.generation, 1);

  const byWorktreeA = registry.getByWorktree("wt_a");
  const byWorktreeB = registry.getByWorktree("wt_b");
  assert.equal(byWorktreeA.session_id, "sess_a");
  assert.equal(byWorktreeB.session_id, "sess_b");
  assert.notEqual(byWorktreeA.session_id, byWorktreeB.session_id);

  assert.equal(registry.getBySessionId("sess_a").worktree_name, "wt_a");
  assert.equal(registry.getBySessionId("sess_b").worktree_name, "wt_b");
  assert.equal(registry.getByWorktree("wt_missing"), null);
  assert.equal(registry.getBySessionId("sess_missing"), null);

  // Mutating returned records must not corrupt internal state.
  byWorktreeA.session_id = "tampered";
  assert.equal(registry.getByWorktree("wt_a").session_id, "sess_a");
});

test("session_id conflict rejects ownership by a different worktree", () => {
  const registry = new GodotAiSessionRegistry();
  bindReady(registry, { worktree_name: "wt_a", session_id: "shared" });

  assert.throws(
    () => bindReady(registry, { worktree_name: "wt_b", session_id: "shared" }),
    (error) => {
      assert.equal(error.code, GODOT_AI_SESSION_CONFLICT);
      assert.match(String(error.message), /shared/);
      return true;
    },
  );

  assert.equal(registry.getBySessionId("shared").worktree_name, "wt_a");
  assert.equal(registry.getByWorktree("wt_b"), null);
});

test("resolveUsableSession never falls back on miss or invalid", () => {
  const registry = new GodotAiSessionRegistry();
  bindReady(registry, { worktree_name: "wt_a", session_id: "sess_a" });
  bindReady(registry, { worktree_name: "wt_b", session_id: "sess_b" });

  const ready = registry.resolveUsableSession("wt_a");
  assert.equal(ready.ok, true);
  assert.equal(ready.session_id, "sess_a");

  const miss = registry.resolveUsableSession("wt_missing");
  assert.equal(miss.ok, false);
  assert.equal(miss.code, GODOT_AI_SESSION_MISS);
  assert.equal(miss.session_id, null);

  registry.markInvalid("wt_b", { code: "SESSION_GONE", message: "plugin disconnected" });
  assert.equal(registry.usable("wt_b"), false);
  assert.equal(registry.getByWorktree("wt_b").observed_state, "session_invalid");
  assert.equal(registry.getByWorktree("wt_b").session_id, "sess_b");

  const invalid = registry.resolveUsableSession("wt_b");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, GODOT_AI_SESSION_NOT_USABLE);
  assert.equal(invalid.session_id, null);
  assert.equal(invalid.observed_state, "session_invalid");

  // Still resolves only the ready worktree; no last-used fallback.
  assert.equal(registry.resolveUsableSession("wt_a").session_id, "sess_a");
});

test("release removes usable association", () => {
  const registry = new GodotAiSessionRegistry();
  bindReady(registry, { worktree_name: "wt_a", session_id: "sess_a" });
  bindReady(registry, { worktree_name: "wt_b", session_id: "sess_b" });

  const released = registry.release("wt_a");
  assert.equal(released.worktree_name, "wt_a");
  assert.equal(released.observed_state, "runtime_no_session");

  assert.equal(registry.getByWorktree("wt_a"), null);
  assert.equal(registry.getBySessionId("sess_a"), null);
  assert.equal(registry.usable("wt_a"), false);

  const resolved = registry.resolveUsableSession("wt_a");
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, GODOT_AI_SESSION_MISS);
  assert.equal(resolved.session_id, null);

  // Sibling worktree remains usable and isolated.
  assert.equal(registry.resolveUsableSession("wt_b").session_id, "sess_b");
  assert.equal(registry.usable("wt_b"), true);
});

test("restore snapshot does not mark sessions usable", () => {
  const registry = new GodotAiSessionRegistry();
  bindReady(registry, {
    worktree_name: "wt_a",
    session_id: "sess_a",
    runtime_pid: 42,
    http_port: 8001,
    ws_port: 9501,
  });
  bindReady(registry, {
    worktree_name: "wt_b",
    session_id: "sess_b",
    observed_state: "session_ready",
  });

  const snap = registry.snapshot();
  assert.equal(snap.schema_version, 1);
  assert.equal(snap.records.length, 2);
  assert.ok(JSON.parse(JSON.stringify(snap)));

  const restored = new GodotAiSessionRegistry();
  const after = restored.restore(snap);
  assert.equal(after.records.length, 2);

  for (const record of after.records) {
    assert.ok(["session_invalid", "runtime_no_session"].includes(record.observed_state));
    assert.notEqual(record.observed_state, "session_ready");
    assert.equal(restored.usable(record.worktree_name), false);
    assert.equal(restored.resolveUsableSession(record.worktree_name).ok, false);
    assert.equal(restored.resolveUsableSession(record.worktree_name).session_id, null);
  }

  const a = restored.getByWorktree("wt_a");
  assert.equal(a.session_id, "sess_a");
  assert.equal(a.observed_state, "session_invalid");
  assert.equal(a.runtime_pid, 42);
  assert.equal(a.last_error.code, "RESTORED_UNVERIFIED");
});

test("rebind with a new session_id increments generation", () => {
  const registry = new GodotAiSessionRegistry();
  const first = bindReady(registry, { worktree_name: "wt_a", session_id: "sess_1" });
  assert.equal(first.generation, 1);

  const second = bindReady(registry, { worktree_name: "wt_a", session_id: "sess_2" });
  assert.equal(second.generation, 2);
  assert.equal(second.session_id, "sess_2");
  assert.equal(registry.getBySessionId("sess_1"), null);
  assert.equal(registry.getBySessionId("sess_2").worktree_name, "wt_a");

  const sameSessionUpdate = bindReady(registry, {
    worktree_name: "wt_a",
    session_id: "sess_2",
    http_port: 8010,
  });
  assert.equal(sameSessionUpdate.generation, 2);
  assert.equal(sameSessionUpdate.http_port, 8010);

  const third = bindReady(registry, { worktree_name: "wt_a", session_id: "sess_3" });
  assert.equal(third.generation, 3);
});

test("markInvalid can classify integration_error and keeps session for diagnosis", () => {
  const registry = new GodotAiSessionRegistry();
  bindReady(registry, { worktree_name: "wt_a", session_id: "sess_a" });

  const marked = registry.markInvalid("wt_a", {
    code: "INTEGRATION_HTTP_DOWN",
    message: "plugin HTTP unreachable",
  });
  assert.equal(marked.observed_state, "integration_error");
  assert.equal(marked.session_id, "sess_a");
  assert.equal(marked.last_error.code, "INTEGRATION_HTTP_DOWN");
  assert.equal(registry.usable("wt_a"), false);
  assert.equal(registry.resolveUsableSession("wt_a").ok, false);
});

test("usable is false for non-ready observed states", () => {
  const registry = new GodotAiSessionRegistry();
  for (const state of ["runtime_stopped", "runtime_no_session", "session_invalid", "integration_error"]) {
    bindReady(registry, {
      worktree_name: "wt_state",
      session_id: `sess_${state}`,
      observed_state: state,
    });
    assert.equal(registry.usable("wt_state"), false, state);
    assert.equal(registry.resolveUsableSession("wt_state").ok, false, state);
  }

  bindReady(registry, {
    worktree_name: "wt_state",
    session_id: "sess_ready",
    observed_state: "session_ready",
  });
  assert.equal(registry.usable("wt_state"), true);
});
