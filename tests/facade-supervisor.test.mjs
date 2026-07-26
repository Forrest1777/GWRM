import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitHealth(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("supervisor not ready");
}

test("MCP facade delegates to singleton supervisor", { timeout: 15000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-facade-"));
  const worktrees = path.join(temp, "worktrees");
  await mkdir(worktrees, { recursive: true });
  const controlPort = await freePort();
  const mcpPort = await freePort();
  const config = {
    schema_version: 1,
    service: { name: "GWRM-test", mcp_port: mcpPort, control_port: controlPort, bind_host: "127.0.0.1", api_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", reconciliation_interval_seconds: 3600, max_active_worktrees: 2, shutdown_timeout_seconds: 5 },
    paths: { node_executable: process.execPath, npm_executable: "npm", powershell_executable: "powershell.exe", godot_executable: process.execPath, windows_workspace_root: temp, container_workspace_root: "/workspace", windows_worktrees_root: worktrees, container_worktrees_root: "/workspace/kanban-worktrees", state_directory: path.join(temp, "state"), logs_directory: path.join(temp, "logs") },
    ports: { lsp_start: 44000, lsp_end: 44010, lsp_proxy_start: 44100, lsp_proxy_end: 44110, dap_start: 44200, dap_end: 44210 },
    sessions: { ready_timeout_seconds: 5, inactive_shutdown_delay_seconds: 0, restart_active_sessions_after_crash: true, remove_configuration_when_worktree_missing: true, require_class_cache_before_ready: true },
    godot: { executable_args_prefix: [path.join(root, "tests", "fixtures", "fake-godot.mjs")], local_ready_host: "127.0.0.1", lsp_relay_enabled: true, lsp_host_for_hermes: "host.docker.internal", additional_editor_args: [] },
    godot_mcp: { command: process.execPath, args: [path.join(root, "tests", "fixtures", "fake-godot-mcp.mjs")], protocol_version: "2024-11-05", startup_timeout_seconds: 5, request_timeout_seconds: 5 },
    gut: { default_test_directory: "res://tests/skill_system/ai_system", allowed_test_root: "res://tests/skill_system/ai_system", timeout_seconds: 5, max_output_characters: 10000, max_concurrent_processes: 1 },
  };
  const configPath = path.join(temp, "config.json");
  await writeFile(configPath, JSON.stringify(config));

  const supervisor = spawn(process.execPath, [path.join(root, "src", "supervisor.mjs"), "--config", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitHealth(controlPort);
    const facade = spawn(process.execPath, [path.join(root, "src", "mcp-facade.mjs"), "--config", configPath], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = readline.createInterface({ input: facade.stdout, crlfDelay: Infinity });
    const messages = [];
    rl.on("line", (line) => messages.push(JSON.parse(line)));
    facade.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
    facade.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gwrm_status", arguments: {} } })}\n`);
    const deadline = Date.now() + 5000;
    while (messages.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(messages[0].result.serverInfo.name, "gwrm");
    const payload = JSON.parse(messages[1].result.content[0].text);
    assert.equal(payload.ready, true);
    assert.equal(payload.service, "GWRM-test");
    facade.kill("SIGTERM");
  } finally {
    supervisor.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(temp, { recursive: true, force: true });
  }
});
