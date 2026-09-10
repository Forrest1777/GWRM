import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { startControlApi } from "../src/control-api.mjs";

const apiKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function startHarness() {
  const calls = [];
  const sessionManager = {
    getOperation(operationId) {
      calls.push(operationId);
      if (operationId === "lifecycle_found") {
        return {
          operation_id: operationId,
          worktree_name: "t_status",
          generation: 7,
          action: "activate",
          status: "completed",
          terminal: true,
        };
      }
      return { operation_id: operationId, status: "not_found", terminal: true };
    },
    listStatuses() { return []; },
  };
  const toolHandler = async (name, args) => ({
    operation_id: "lifecycle_from_post",
    generation: 8,
    name,
    args,
  });
  const logger = { info() {}, error() {} };
  const server = startControlApi({
    service: { name: "GWRM-control-api-test", apiKey, controlPort: 0, bindHost: "127.0.0.1" },
  }, sessionManager, toolHandler, logger);
  return { server, calls };
}

async function request(port, path, options = {}) {
  return await fetch(`http://127.0.0.1:${port}${path}`, options);
}

test("Control API consulta operacao autenticada em porta dinamica sem quebrar POST de tools", async () => {
  const { server, calls } = startHarness();
  try {
    await once(server, "listening");
    const port = server.address().port;

    const unauthorized = await request(port, "/api/v1/worktree-operations/lifecycle_found");
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

    const headers = { "X-API-Key": apiKey };
    const found = await request(port, "/api/v1/worktree-operations/lifecycle_found", { headers });
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), {
      operation_id: "lifecycle_found",
      worktree_name: "t_status",
      generation: 7,
      action: "activate",
      status: "completed",
      terminal: true,
    });

    const missing = await request(port, "/api/v1/worktree-operations/lifecycle_missing", { headers });
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), {
      operation_id: "lifecycle_missing",
      status: "not_found",
      terminal: true,
    });
    assert.deepEqual(calls, ["lifecycle_found", "lifecycle_missing"]);

    const existingPost = await request(port, "/api/v1/tools/call", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "activate_worktree", arguments: { worktree_name: "t_status" } }),
    });
    assert.equal(existingPost.status, 200);
    assert.deepEqual(await existingPost.json(), {
      result: {
        operation_id: "lifecycle_from_post",
        generation: 8,
        name: "activate_worktree",
        args: { worktree_name: "t_status" },
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
