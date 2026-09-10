import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../src/logger.mjs";
import { SessionManager } from "../src/session-manager.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function createHarness(prefix, portOffset) {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const worktrees = path.join(temp, "worktrees");
  const worktree = path.join(worktrees, "t_lifecycle");
  const stateDirectory = path.join(temp, "state");
  await mkdir(path.join(worktree, "addons", "gut"), { recursive: true });
  await writeFile(path.join(worktree, "project.godot"), "[application]\nconfig/name=\"lifecycle\"\n");
  await writeFile(path.join(worktree, "addons", "gut", "gut_cmdln.gd"), "# fake\n");

  const config = {
    appRoot: root,
    service: { bindHost: "127.0.0.1", reconciliationIntervalSeconds: 3600, maxActiveWorktrees: 2, shutdownTimeoutSeconds: 5 },
    paths: {
      stateDirectory,
      logsDirectory: path.join(temp, "logs"),
      windowsWorktreesRoot: worktrees,
      containerWorktreesRoot: "/workspace/lifecycle-tests/.worktrees",
      godotExecutable: process.execPath,
      powershellExecutable: "powershell.exe",
    },
    ports: {
      lspStart: portOffset,
      lspEnd: portOffset + 20,
      lspProxyStart: portOffset + 100,
      lspProxyEnd: portOffset + 120,
      dapStart: portOffset + 200,
      dapEnd: portOffset + 220,
    },
    sessions: {
      readyTimeoutSeconds: 8,
      inactiveShutdownDelaySeconds: 0,
      requireClassCacheBeforeReady: true,
      removeConfigurationWhenWorktreeMissing: true,
      restartActiveSessionsAfterCrash: true,
    },
    godot: {
      executableArgsPrefix: [path.join(root, "tests", "fixtures", "fake-godot.mjs")],
      localReadyHost: "127.0.0.1",
      lspHostForHermes: "host.docker.internal",
      lspRelayEnabled: true,
      additionalEditorArgs: [],
    },
    godotMcp: {
      command: process.execPath,
      args: [path.join(root, "tests", "fixtures", "fake-godot-mcp.mjs")],
      protocolVersion: "2024-11-05",
      startupTimeoutSeconds: 5,
      requestTimeoutSeconds: 5,
    },
    gut: { defaultTestDirectory: "res://tests", allowedTestRoot: "res://tests", timeoutSeconds: 5, maxOutputCharacters: 10000, maxConcurrentProcesses: 1 },
  };
  const logger = new Logger(config.paths.logsDirectory);
  await logger.init();
  return { temp, worktree, stateDirectory, config, logger };
}

function assertOperationShape(operation) {
  for (const field of [
    "operation_id", "worktree_name", "generation", "action", "desired_active", "status",
    "terminal", "requested_at", "updated_at", "completed_at", "error", "observed_state",
  ]) assert.ok(Object.hasOwn(operation, field), `operation includes ${field}`);
  assert.equal(typeof operation.observed_state, "object");
  assert.ok(Object.hasOwn(operation.observed_state, "status"));
  assert.ok(Object.hasOwn(operation.observed_state, "residual_pids"));
  assert.ok(Object.hasOwn(operation.observed_state, "directory_released"));
}

test("persistent lifecycle reuses equivalent operations across retries and clean deactivation", { timeout: 30000 }, async () => {
  const harness = await createHarness("gwrm-lifecycle-", 45000);
  const sessions = new SessionManager(harness.config, harness.logger);
  await sessions.init();
  try {
    const [first, concurrent] = await Promise.all([
      sessions.activateWorktree("t_lifecycle", "first"),
      sessions.activateWorktree("t_lifecycle", "concurrent"),
    ]);
    assert.match(first.operation_id, /^lifecycle_/);
    assert.equal(concurrent.operation_id, first.operation_id);
    assert.equal(concurrent.generation, first.generation);
    assert.equal(concurrent.godot_pid, first.godot_pid);
    assert.equal(concurrent.godot_mcp_pid, first.godot_mcp_pid);

    const retry = await sessions.activateWorktree("t_lifecycle", "lost-response-retry");
    assert.equal(retry.operation_id, first.operation_id);
    assert.equal(retry.generation, first.generation);

    const activeOperation = sessions.getOperation(first.operation_id);
    assertOperationShape(activeOperation);
    assert.equal(activeOperation.status, "completed");
    assert.equal(activeOperation.terminal, true);
    assert.equal(activeOperation.desired_active, true);

    const persisted = JSON.parse(await readFile(path.join(harness.stateDirectory, "t_lifecycle.json"), "utf8"));
    assert.equal(persisted.schema_version, 2);
    assert.equal(persisted.operations.length, 1);
    assert.equal(persisted.operations[0].operation_id, first.operation_id);

    const stopped = await sessions.deactivateWorktree("t_lifecycle", "stop");
    const stoppedAgain = await sessions.deactivateWorktree("t_lifecycle", "stop-retry");
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(stopped.residual_pids, []);
    assert.equal(stopped.directory_released, true);
    assert.equal(stoppedAgain.operation_id, stopped.operation_id);
    assert.equal(stoppedAgain.generation, stopped.generation);
    assert.equal(stopped.generation, first.generation + 1);

    const stopOperation = sessions.getOperation(stopped.operation_id);
    assertOperationShape(stopOperation);
    assert.equal(stopOperation.status, "completed");
    assert.equal(stopOperation.observed_state.status, "stopped");
    assert.deepEqual(stopOperation.observed_state.residual_pids, []);
    assert.equal(stopOperation.observed_state.directory_released, true);
    assert.deepEqual(sessions.getOperation("lifecycle_missing"), {
      operation_id: "lifecycle_missing",
      status: "not_found",
      terminal: true,
    });
  } finally {
    await sessions.shutdown();
    await rm(harness.temp, { recursive: true, force: true });
  }
});

test("restart resumes a non-terminal persisted activation and preserves its operation identity", { timeout: 30000 }, async () => {
  const harness = await createHarness("gwrm-lifecycle-restart-", 46000);
  const requestedAt = new Date().toISOString();
  await mkdir(harness.stateDirectory, { recursive: true });
  await writeFile(path.join(harness.stateDirectory, "t_lifecycle.json"), JSON.stringify({
    schema_version: 1,
    worktree_name: "t_lifecycle",
    container_project_path: "/obsolete/t_lifecycle",
    host_project_path: "/obsolete/t_lifecycle",
    desired_active: true,
    status: "starting",
    lsp_port: null,
    godot_lsp_port: null,
    dap_port: null,
    godot_pid: null,
    godot_mcp_pid: null,
    residual_pids: [],
    directory_released: false,
    created_at: requestedAt,
    updated_at: requestedAt,
    operations: [{
      operation_id: "lifecycle_restart_operation",
      worktree_name: "t_lifecycle",
      generation: 7,
      action: "activate",
      desired_active: true,
      status: "running",
      terminal: false,
      requested_at: requestedAt,
      updated_at: requestedAt,
      completed_at: null,
      error: null,
      observed_state: { status: "starting", runtime: { godot_pid: null, godot_mcp_pid: null }, residual_pids: [], directory_released: false },
    }],
    current_operation_id: "lifecycle_restart_operation",
  }, null, 2));

  const sessions = new SessionManager(harness.config, harness.logger);
  await sessions.init();
  try {
    const operation = sessions.getOperation("lifecycle_restart_operation");
    assert.equal(operation.generation, 7);
    assert.equal(operation.status, "completed");
    assert.equal(operation.terminal, true);
    assert.equal(operation.observed_state.status, "ready");
    assert.equal(sessions.getStatus("t_lifecycle").status, "ready");

    const retry = await sessions.activateWorktree("t_lifecycle", "after-restart");
    assert.equal(retry.operation_id, "lifecycle_restart_operation");
    assert.equal(retry.generation, 7);
  } finally {
    await sessions.shutdown();
    await rm(harness.temp, { recursive: true, force: true });
  }
});

test("opposite desired state supersedes a persisted non-terminal generation", { timeout: 30000 }, async () => {
  const harness = await createHarness("gwrm-lifecycle-supersede-", 47000);
  const requestedAt = new Date().toISOString();
  await mkdir(harness.stateDirectory, { recursive: true });
  await writeFile(path.join(harness.stateDirectory, "t_lifecycle.json"), JSON.stringify({
    schema_version: 2,
    worktree_name: "t_lifecycle",
    container_project_path: "/workspace/lifecycle-tests/.worktrees/t_lifecycle",
    host_project_path: harness.worktree,
    desired_active: true,
    status: "starting",
    lsp_port: null,
    godot_lsp_port: null,
    dap_port: null,
    godot_pid: null,
    godot_mcp_pid: null,
    residual_pids: [],
    directory_released: false,
    created_at: requestedAt,
    updated_at: requestedAt,
    operations: [{
      operation_id: "lifecycle_pending_activation",
      worktree_name: "t_lifecycle",
      generation: 3,
      action: "activate",
      desired_active: true,
      status: "running",
      terminal: false,
      requested_at: requestedAt,
      updated_at: requestedAt,
      completed_at: null,
      error: null,
      observed_state: { status: "starting", runtime: { active: false }, residual_pids: [], directory_released: false },
    }],
    current_operation_id: "lifecycle_pending_activation",
  }, null, 2));

  const sessions = new SessionManager(harness.config, harness.logger);
  // Simulate a request received after state recovery but before the startup
  // reconcile advances the durable activation operation.
  sessions.reconcileAll = async () => {};
  await sessions.init();
  try {
    const stopped = await sessions.deactivateWorktree("t_lifecycle", "opposite-request");
    assert.equal(stopped.generation, 4);
    assert.equal(stopped.status, "stopped");
    const superseded = sessions.getOperation("lifecycle_pending_activation");
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.terminal, true);
    assert.equal(superseded.completed_at !== null, true);
    const finalOperation = sessions.getOperation(stopped.operation_id);
    assert.equal(finalOperation.status, "completed");
    assert.equal(finalOperation.desired_active, false);
  } finally {
    await sessions.shutdown();
    await rm(harness.temp, { recursive: true, force: true });
  }
});
