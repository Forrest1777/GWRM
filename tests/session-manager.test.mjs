import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../src/logger.mjs";
import { SessionManager } from "../src/session-manager.mjs";
import { GutRunner } from "../src/gut-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("activate, route MCP, run GUT and deactivate isolated worktree", { timeout: 20000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-test-"));
  const worktrees = path.join(temp, "worktrees");
  const worktree = path.join(worktrees, "t_test");
  await mkdir(path.join(worktree, "addons", "gut"), { recursive: true });
  await writeFile(path.join(worktree, "project.godot"), "[application]\nconfig/name=\"test\"\n");
  await writeFile(path.join(worktree, "addons", "gut", "gut_cmdln.gd"), "# fake\n");

  const config = {
    appRoot: root,
    service: { bindHost: "127.0.0.1", reconciliationIntervalSeconds: 3600, maxActiveWorktrees: 2, shutdownTimeoutSeconds: 5 },
    paths: { stateDirectory: path.join(temp, "state"), logsDirectory: path.join(temp, "logs"), windowsWorktreesRoot: worktrees, containerWorktreesRoot: "/workspace/skill_system_framework/.worktrees", godotExecutable: process.execPath, powershellExecutable: "powershell.exe" },
    ports: { lspStart: 43000, lspEnd: 43100, lspProxyStart: 43200, lspProxyEnd: 43300, dapStart: 43400, dapEnd: 43500 },
    sessions: { readyTimeoutSeconds: 8, requireClassCacheBeforeReady: true, removeConfigurationWhenWorktreeMissing: true },
    godot: { executableArgsPrefix: [path.join(root, "tests", "fixtures", "fake-godot.mjs")], localReadyHost: "127.0.0.1", lspHostForHermes: "host.docker.internal", lspRelayEnabled: true, additionalEditorArgs: [] },
    godotMcp: { command: process.execPath, args: [path.join(root, "tests", "fixtures", "fake-godot-mcp.mjs")], protocolVersion: "2024-11-05", startupTimeoutSeconds: 5, requestTimeoutSeconds: 5 },
    gut: { defaultTestDirectory: "res://tests/skill_system/ai_system", allowedTestRoot: "res://tests/skill_system/ai_system", timeoutSeconds: 5, maxOutputCharacters: 10000, maxConcurrentProcesses: 1 },
  };
  const logger = new Logger(config.paths.logsDirectory);
  await logger.init();
  const sessions = new SessionManager(config, logger);
  await sessions.init();
  try {
    const status = await sessions.activateWorktree("t_test", "test");
    assert.equal(status.status, "ready");
    assert.equal(status.godot_mcp_ready, true);
    assert.notEqual(status.lsp.port, status.lsp.godot_internal_port);

    const response = await sessions.callGodotTool("t_test", "get_project_info", { worktree_name: "t_test" });
    const body = JSON.parse(response.content[0].text);
    assert.equal(body.args.projectPath, worktree);

    const gut = new GutRunner(config, sessions, logger);
    const result = await gut.runDirectory("t_test", "res://tests/skill_system/ai_system");
    assert.equal(result.passed, true);
    assert.equal(result.result_source, "junit_xml");
    assert.equal(result.junit_xml_generated, true);
    assert.equal(result.counts.tests, 3);

    const stopped = await sessions.deactivateWorktree("t_test", "test");
    assert.equal(stopped.desired_active, false);
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(stopped.residual_pids, []);
    assert.equal(stopped.directory_released, true);
    assert.equal(stopped.godot_mcp_ready, false);
  } finally {
    await sessions.shutdown();
    await rm(temp, { recursive: true, force: true });
  }
});


test("migrate persisted state paths when worktree root changes", { timeout: 20000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-state-migrate-"));
  const worktrees = path.join(temp, "new-worktrees");
  const worktree = path.join(worktrees, "t_migrate");
  const stateDirectory = path.join(temp, "state");
  await mkdir(path.join(worktree, "addons", "gut"), { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(worktree, "project.godot"), "[application]\nconfig/name=\"test\"\n");
  await writeFile(path.join(worktree, "addons", "gut", "gut_cmdln.gd"), "# fake\n");
  await writeFile(path.join(stateDirectory, "t_migrate.json"), JSON.stringify({
    schema_version: 1,
    worktree_name: "t_migrate",
    container_project_path: "/workspace/kanban-worktrees/t_migrate",
    host_project_path: path.join(temp, "old-worktrees", "t_migrate"),
    desired_active: false,
    status: "stopped",
    lsp_port: null,
    godot_lsp_port: null,
    dap_port: null,
    godot_pid: null,
    godot_mcp_pid: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, null, 2));

  const config = {
    appRoot: root,
    service: { bindHost: "127.0.0.1", reconciliationIntervalSeconds: 3600, maxActiveWorktrees: 2, shutdownTimeoutSeconds: 5 },
    paths: { stateDirectory, logsDirectory: path.join(temp, "logs"), windowsWorktreesRoot: worktrees, containerWorktreesRoot: "/workspace/skill_system_framework/.worktrees", godotExecutable: process.execPath, powershellExecutable: "powershell.exe" },
    ports: { lspStart: 43600, lspEnd: 43700, lspProxyStart: 43800, lspProxyEnd: 43900, dapStart: 44000, dapEnd: 44100 },
    sessions: { readyTimeoutSeconds: 8, inactiveShutdownDelaySeconds: 0, requireClassCacheBeforeReady: true, removeConfigurationWhenWorktreeMissing: true, restartActiveSessionsAfterCrash: true },
    godot: { executableArgsPrefix: [path.join(root, "tests", "fixtures", "fake-godot.mjs")], localReadyHost: "127.0.0.1", lspHostForHermes: "host.docker.internal", lspRelayEnabled: true, additionalEditorArgs: [] },
    godotMcp: { command: process.execPath, args: [path.join(root, "tests", "fixtures", "fake-godot-mcp.mjs")], protocolVersion: "2024-11-05", startupTimeoutSeconds: 5, requestTimeoutSeconds: 5 },
    gut: { defaultTestDirectory: "res://tests/skill_system/ai_system", allowedTestRoot: "res://tests/skill_system/ai_system", timeoutSeconds: 5, maxOutputCharacters: 10000, maxConcurrentProcesses: 1 },
  };
  const logger = new Logger(config.paths.logsDirectory);
  await logger.init();
  const sessions = new SessionManager(config, logger);
  await sessions.init();
  try {
    const initial = sessions.getStatus("t_migrate");
    assert.equal(initial.host_project_path, worktree);
    assert.equal(initial.container_project_path, "/workspace/skill_system_framework/.worktrees/t_migrate");
    const ready = await sessions.activateWorktree("t_migrate", "test");
    assert.equal(ready.status, "ready");
    const stopped = await sessions.deactivateWorktree("t_migrate", "test");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.directory_released, true);
  } finally {
    await sessions.shutdown();
    await rm(temp, { recursive: true, force: true });
  }
});
