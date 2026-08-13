import test from "node:test";
import assert from "node:assert/strict";
import {
  isSafeToRetrySupervisorTool,
  supervisorRequestTimeoutMs,
} from "../src/mcp-facade-policy.mjs";

const config = {
  service: { shutdownTimeoutSeconds: 10 },
  sessions: { readyTimeoutSeconds: 180 },
  godotMcp: { requestTimeoutSeconds: 300 },
  gut: { timeoutSeconds: 600 },
};

test("GUT supervisionado usa somente timeout curto de control-plane", () => {
  assert.equal(supervisorRequestTimeoutMs(config, "run_gut_tests"), 60000);
  assert.equal(supervisorRequestTimeoutMs(config, "run_gut_test_script"), 60000);
  assert.equal(supervisorRequestTimeoutMs(config, "get_gut_run_status"), 60000);
});

test("ativacao e desativacao usam timeouts adequados", () => {
  assert.equal(supervisorRequestTimeoutMs(config, "activate_worktree"), 210000);
  assert.equal(supervisorRequestTimeoutMs(config, "deactivate_worktree"), 40000);
});

test("somente consultas idempotentes podem ser repetidas", () => {
  assert.equal(isSafeToRetrySupervisorTool("gwrm_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("get_worktree_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("get_gut_run_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("run_gut_tests"), false);
  assert.equal(isSafeToRetrySupervisorTool("activate_worktree"), false);
  assert.equal(isSafeToRetrySupervisorTool("run_project"), false);
});
