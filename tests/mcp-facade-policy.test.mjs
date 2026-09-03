import test from "node:test";
import assert from "node:assert/strict";
import { isSafeToRetrySupervisorTool, supervisorRequestTimeoutMs } from "../src/mcp-facade-policy.mjs";

const config = {
  sessions: { readyTimeoutSeconds: 180 },
  service: { shutdownTimeoutSeconds: 10 },
  godotMcp: { requestTimeoutSeconds: 300 },
  computerUse: { requestTimeoutSeconds: 60, maxWaitTimeoutSeconds: 60 },
};

test("read/status tools are retry-safe while mutating tools are not", () => {
  assert.equal(isSafeToRetrySupervisorTool("gwrm_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("gui_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("gui_inspect_window"), true);
  assert.equal(isSafeToRetrySupervisorTool("gui_click"), false);
  assert.equal(isSafeToRetrySupervisorTool("run_project"), false);
});

test("supervisor timeout policy keeps GUI waits bounded", () => {
  assert.ok(supervisorRequestTimeoutMs(config, "gui_wait_for_window") >= 60_000);
  assert.ok(supervisorRequestTimeoutMs(config, "launch_editor") >= 300_000);
});
