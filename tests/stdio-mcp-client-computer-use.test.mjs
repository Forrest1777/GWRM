import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../src/stdio-mcp-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logger = { info: async () => {}, warn: async () => {}, error: async () => {} };

test("StdioMcpClient supervisiona Cua MCP e encerra por EOF", async () => {
  const client = new StdioMcpClient({
    command: process.execPath,
    args: [path.join(root, "tests", "fixtures", "fake-cua-mcp.mjs")],
    cwd: root,
    env: process.env,
    protocolVersion: "2024-11-05",
    startupTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    logger,
    serverName: "Cua Driver",
    label: null,
  });
  await client.start();
  assert.equal(client.isAlive, true);
  assert.equal(client.hasTool("get_window_state"), true);
  const result = await client.callTool("list_windows", {});
  assert.deepEqual(result.structuredContent.windows, []);
  await client.close();
  assert.equal(client.isAlive, false);
});
