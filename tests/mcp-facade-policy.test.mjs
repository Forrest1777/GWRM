import test from "node:test";
import assert from "node:assert/strict";
import {
  isSafeToRetrySupervisorTool,
  supervisorRequestTimeoutMs,
} from "../src/mcp-facade-policy.mjs";
import { buildToolHandler, buildTools } from "../src/tools.mjs";

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
  assert.equal(supervisorRequestTimeoutMs(config, "get_worktree_operation_status"), 60000);
});

test("ativacao e desativacao usam timeouts adequados", () => {
  assert.equal(supervisorRequestTimeoutMs(config, "activate_worktree"), 210000);
  assert.equal(supervisorRequestTimeoutMs(config, "deactivate_worktree"), 40000);
});

test("somente consultas idempotentes podem ser repetidas", () => {
  assert.equal(isSafeToRetrySupervisorTool("gwrm_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("get_worktree_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("get_worktree_operation_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("get_gut_run_status"), true);
  assert.equal(isSafeToRetrySupervisorTool("run_gut_tests"), false);
  assert.equal(isSafeToRetrySupervisorTool("activate_worktree"), false);
  assert.equal(isSafeToRetrySupervisorTool("run_project"), false);
});

test("status de operacao expõe o contrato MCP e delega sem efeitos de runtime", async () => {
  const definition = buildTools().find((tool) => tool.name === "get_worktree_operation_status");
  assert.deepEqual(definition.inputSchema, {
    type: "object",
    properties: {
      operation_id: {
        type: "string",
        description: "operation_id retornado por activate_worktree ou deactivate_worktree.",
      },
    },
    required: ["operation_id"],
    additionalProperties: false,
  });

  const expected = { operation_id: "lifecycle_123", status: "completed", terminal: true };
  const sessionManager = {
    getOperation(operationId) {
      assert.equal(operationId, "lifecycle_123");
      return expected;
    },
  };
  const handler = buildToolHandler({}, sessionManager, null, null);
  assert.equal(await handler("get_worktree_operation_status", { operation_id: "lifecycle_123" }), expected);
});
