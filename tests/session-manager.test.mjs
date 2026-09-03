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

function configFor(temp, worktrees) {
  return {
    appRoot: root,
    service: { bindHost: "127.0.0.1", reconciliationIntervalSeconds: 3600, maxActiveWorktrees: 2, shutdownTimeoutSeconds: 5 },
    paths: {
      stateDirectory: path.join(temp, "state"), logsDirectory: path.join(temp, "logs"),
      windowsWorktreesRoot: worktrees, containerWorktreesRoot: "/workspace/project/.worktrees",
      godotExecutable: process.execPath, powershellExecutable: "powershell.exe",
    },
    ports: { lspStart: 43000, lspEnd: 43100, lspProxyStart: 43200, lspProxyEnd: 43300, dapStart: 43400, dapEnd: 43500 },
    sessions: { readyTimeoutSeconds: 8, inactiveShutdownDelaySeconds: 0, requireClassCacheBeforeReady: true, removeConfigurationWhenWorktreeMissing: true, restartActiveSessionsAfterCrash: true },
    godot: { executableArgsPrefix: [path.join(root, "tests", "fixtures", "fake-godot.mjs")], localReadyHost: "127.0.0.1", lspHostForHermes: "host.docker.internal", lspRelayEnabled: true, additionalEditorArgs: [] },
    godotMcp: { command: process.execPath, args: [path.join(root, "tests", "fixtures", "fake-godot-mcp.mjs")], protocolVersion: "2024-11-05", startupTimeoutSeconds: 5, requestTimeoutSeconds: 5 },
    gut: { defaultTestDirectory: "res://tests", allowedTestRoot: "res://tests", timeoutSeconds: 5, maxOutputCharacters: 10000, maxConcurrentProcesses: 1 },
  };
}

test("worktree runtime is isolated, reusable, and cleanly deactivated", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-session-"));
  const worktrees = path.join(temp, "worktrees");
  const worktree = path.join(worktrees, "t_test");
  await mkdir(path.join(worktree, "addons", "gut"), { recursive: true });
  await writeFile(path.join(worktree, "project.godot"), "[application]\nconfig/name=\"test\"\n");
  await writeFile(path.join(worktree, "addons", "gut", "gut_cmdln.gd"), "# fake\n");
  const config = configFor(temp, worktrees);
  const logger = new Logger(config.paths.logsDirectory);
  await logger.init();
  const sessions = new SessionManager(config, logger);
  await sessions.init();
  try {
    const ready = await sessions.activateWorktree("t_test", "test");
    assert.equal(ready.status, "ready");
    assert.equal(ready.godot_mcp_ready, true);
    const repeated = await sessions.activateWorktree("t_test", "repeat");
    assert.equal(repeated.godot_pid, ready.godot_pid);
    assert.equal(repeated.godot_mcp_pid, ready.godot_mcp_pid);
    assert.equal(repeated.reused_existing_runtime, true);

    await sessions.callGodotTool("t_test", "run_project", { worktree_name: "t_test" });
    assert.equal(sessions.getStatus("t_test").project_started, true);
    await sessions.stopProject("t_test");
    assert.equal(sessions.getStatus("t_test").project_started, false);

    const gut = new GutRunner(config, sessions, logger);
    const started = gut.startDirectory("t_test", "res://tests");
    const deadline = Date.now() + 5000;
    let operation = gut.getOperation(started.operation_id);
    while (!operation.terminal && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      operation = gut.getOperation(started.operation_id);
    }
    assert.equal(operation.status, "completed");
    assert.equal(operation.result.passed, true);
    assert.equal(operation.result.counts.tests, 3);

    const stopped = await sessions.deactivateWorktree("t_test", "test");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.directory_released, true);
    assert.deepEqual(stopped.residual_pids, []);
  } finally {
    await sessions.shutdown();
    await rm(temp, { recursive: true, force: true });
  }
});
