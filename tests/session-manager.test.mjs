import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Logger } from "../src/logger.mjs";
import { SessionManager } from "../src/session-manager.mjs";
import { GutRunner } from "../src/gut-runner.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("activate, route MCP, run GUT and deactivate isolated worktree", { timeout: 20000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-test-"));
  const worktrees = path.join(temp, "worktrees");
  const worktree = path.join(worktrees, "t_test");
  await mkdir(path.join(worktree, "addons", "gut"), { recursive: true });
  await writeFile(path.join(worktree, "project.godot"), "[application]\nconfig/name=\"test\"\n");
  await writeFile(path.join(worktree, "addons", "gut", "gut_cmdln.gd"), "# fake\n");

  const config = {
    appRoot: root,
    service: { bindHost: "127.0.0.1", reconciliationIntervalSeconds: 3600, maxActiveWorktrees: 2 },
    paths: { stateDirectory: path.join(temp, "state"), logsDirectory: path.join(temp, "logs"), windowsWorktreesRoot: worktrees, containerWorktreesRoot: "/workspace/kanban-worktrees", godotExecutable: process.execPath, powershellExecutable: "powershell.exe" },
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

    const stopped = await sessions.deactivateWorktree("t_test", "test");
    assert.equal(stopped.desired_active, false);
    assert.equal(stopped.status, "stopped");
  } finally {
    await sessions.shutdown();
    await rm(temp, { recursive: true, force: true });
  }
});
