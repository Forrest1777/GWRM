import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../src/logger.mjs";
import { SessionManager } from "../src/session-manager.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function buildConfig(temp, worktrees, portBase) {
  return {
    appRoot: root,
    service: {
      bindHost: "127.0.0.1",
      reconciliationIntervalSeconds: 3600,
      maxActiveWorktrees: 4,
      shutdownTimeoutSeconds: 5,
    },
    paths: {
      stateDirectory: path.join(temp, "state"),
      logsDirectory: path.join(temp, "logs"),
      windowsWorktreesRoot: worktrees,
      containerWorktreesRoot: "/workspace/skill_system_framework/.worktrees",
      godotExecutable: process.execPath,
      powershellExecutable: "powershell.exe",
    },
    ports: {
      lspStart: portBase,
      lspEnd: portBase + 99,
      lspProxyStart: portBase + 200,
      lspProxyEnd: portBase + 299,
      dapStart: portBase + 400,
      dapEnd: portBase + 499,
      // Isolated ranges away from production 18000/19500 defaults.
      godotAiHttpStart: portBase + 1000,
      godotAiHttpEnd: portBase + 1099,
      godotAiWsStart: portBase + 1200,
      godotAiWsEnd: portBase + 1299,
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
    gut: {
      defaultTestDirectory: "res://tests/skill_system/ai_system",
      allowedTestRoot: "res://tests/skill_system/ai_system",
      timeoutSeconds: 5,
      maxOutputCharacters: 10000,
      maxConcurrentProcesses: 1,
    },
  };
}

async function prepareWorktree(worktrees, name) {
  const worktree = path.join(worktrees, name);
  await mkdir(path.join(worktree, "addons", "gut"), { recursive: true });
  await writeFile(path.join(worktree, "project.godot"), "[application]\nconfig/name=\"test\"\n");
  await writeFile(path.join(worktree, "addons", "gut", "gut_cmdln.gd"), "# fake\n");
  return worktree;
}

function assertGodotAiShape(godotAi) {
  assert.equal(typeof godotAi, "object");
  assert.ok(godotAi);
  assert.equal(Object.prototype.hasOwnProperty.call(godotAi, "status"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(godotAi, "session_id"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(godotAi, "http_port"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(godotAi, "ws_port"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(godotAi, "gui_pid"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(godotAi, "last_error"), true);
}

async function listFilesRecursive(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(full));
    else files.push(full);
  }
  return files;
}

function baseDependencies(fakeAppData) {
  return {
    godotAiAppdataDir: fakeAppData,
    // Without EditorSettings fixture / attach fakes, critical section fails closed.
    godotAiProcessLister: async () => [],
    isPidAlive: () => false,
    godotAiWaitForListen: async () => {
      throw new Error("listen not expected without fakes");
    },
  };
}

test("allocate sticky disjoint Godot AI HTTP/WS ports and expose getStatus.godot_ai", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-ports-"));
  const worktrees = path.join(temp, "worktrees");
  const fakeAppData = path.join(temp, "APPDATA");
  const fakeGodotUser = path.join(fakeAppData, "Godot");
  await mkdir(fakeGodotUser, { recursive: true });
  await prepareWorktree(worktrees, "t_a");
  await prepareWorktree(worktrees, "t_b");

  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = fakeAppData;

  const config = buildConfig(temp, worktrees, 51000);
  const logger = new Logger(config.paths.logsDirectory);
  await logger.init();
  const sessions = new SessionManager(config, logger, baseDependencies(fakeAppData));
  await sessions.init();

  try {
    const missing = sessions.getStatus("t_missing");
    assert.equal(missing.status, "not_registered");
    assertGodotAiShape(missing.godot_ai);
    assert.equal(missing.godot_ai.status, "runtime_stopped");
    assert.equal(missing.godot_ai.session_id, null);
    assert.equal(missing.godot_ai.http_port, null);
    assert.equal(missing.godot_ai.ws_port, null);
    assert.equal(missing.godot_ai.gui_pid, null);
    assert.equal(missing.godot_ai.last_error, null);

    const a = await sessions.activateWorktree("t_a", "test");
    assert.equal(a.status, "ready");
    assertGodotAiShape(a.godot_ai);
    // Without EditorSettings fixture the critical section fails closed; ports stay sticky.
    assert.equal(a.godot_ai.status, "integration_error");
    assert.equal(a.godot_ai.session_id, null);
    assert.equal(a.godot_ai.last_error?.code, "godot_ai_editor_settings_failed");
    assert.equal(Number.isInteger(a.godot_ai.http_port), true);
    assert.equal(Number.isInteger(a.godot_ai.ws_port), true);
    assert.ok(a.godot_ai.http_port >= config.ports.godotAiHttpStart && a.godot_ai.http_port <= config.ports.godotAiHttpEnd);
    assert.ok(a.godot_ai.ws_port >= config.ports.godotAiWsStart && a.godot_ai.ws_port <= config.ports.godotAiWsEnd);

    const b = await sessions.activateWorktree("t_b", "test");
    assert.equal(b.status, "ready");
    assert.equal(b.godot_ai.status, "integration_error");
    assert.equal(Number.isInteger(b.godot_ai.http_port), true);
    assert.equal(Number.isInteger(b.godot_ai.ws_port), true);
    assert.notEqual(a.godot_ai.http_port, b.godot_ai.http_port);
    assert.notEqual(a.godot_ai.ws_port, b.godot_ai.ws_port);

    const pairA = { http: a.godot_ai.http_port, ws: a.godot_ai.ws_port };
    const pairB = { http: b.godot_ai.http_port, ws: b.godot_ai.ws_port };

    const reusedA = await sessions.activateWorktree("t_a", "test-repeat");
    assert.equal(reusedA.status, "ready");
    assert.equal(reusedA.godot_ai.http_port, pairA.http);
    assert.equal(reusedA.godot_ai.ws_port, pairA.ws);
    assert.equal(reusedA.godot_ai.status, "integration_error");

    const stoppedA = await sessions.deactivateWorktree("t_a", "test");
    assert.equal(stoppedA.status, "stopped");
    assert.equal(stoppedA.godot_ai.status, "runtime_stopped");
    assert.equal(stoppedA.godot_ai.http_port, pairA.http);
    assert.equal(stoppedA.godot_ai.ws_port, pairA.ws);
    assert.equal(stoppedA.godot_ai.session_id, null);

    const stateAfterStop = JSON.parse(await readFile(path.join(config.paths.stateDirectory, "t_a.json"), "utf8"));
    assert.equal(stateAfterStop.godot_ai_http_port, pairA.http);
    assert.equal(stateAfterStop.godot_ai_ws_port, pairA.ws);

    const reactivatedA = await sessions.activateWorktree("t_a", "test-reactivate");
    assert.equal(reactivatedA.status, "ready");
    assert.equal(reactivatedA.godot_ai.status, "integration_error");
    assert.equal(reactivatedA.godot_ai.http_port, pairA.http);
    assert.equal(reactivatedA.godot_ai.ws_port, pairA.ws);

    const stillB = sessions.getStatus("t_b");
    assert.equal(stillB.status, "ready");
    assert.equal(stillB.godot_ai.http_port, pairB.http);
    assert.equal(stillB.godot_ai.ws_port, pairB.ws);

    // Fail-closed applyPorts must not create a missing EditorSettings file.
    const godotFiles = await listFilesRecursive(fakeGodotUser);
    assert.deepEqual(godotFiles, []);
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    await sessions.shutdown();
    await rm(temp, { recursive: true, force: true });
  }
});

test("Godot AI allocation failure keeps TODO9 ready and sets integration_error", { timeout: 20000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-ports-fail-"));
  const worktrees = path.join(temp, "worktrees");
  const fakeAppData = path.join(temp, "APPDATA");
  await mkdir(path.join(fakeAppData, "Godot"), { recursive: true });
  await prepareWorktree(worktrees, "t_fail");

  const config = buildConfig(temp, worktrees, 53000);
  // Exhaust the HTTP range immediately so allocation fails without affecting TODO9 ports.
  config.ports.godotAiHttpStart = 53990;
  config.ports.godotAiHttpEnd = 53990;

  const logger = new Logger(config.paths.logsDirectory);
  await logger.init();
  const sessions = new SessionManager(config, logger, baseDependencies(fakeAppData));
  await sessions.init();

  const holders = [];
  try {
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 53990, exclusive: true }, resolve);
    });
    holders.push(server);

    const status = await sessions.activateWorktree("t_fail", "test");
    assert.equal(status.status, "ready");
    assert.equal(status.desired_active, true);
    assert.equal(status.last_error, null);
    assert.equal(status.godot_ai.status, "integration_error");
    assert.equal(status.godot_ai.session_id, null);
    assert.equal(status.godot_ai.last_error?.code, "godot_ai_port_allocation_failed");
    assert.match(status.godot_ai.last_error?.message || "", /porta/i);
  } finally {
    await Promise.all(holders.map((server) => new Promise((resolve) => server.close(() => resolve()))));
    await sessions.shutdown();
    await rm(temp, { recursive: true, force: true });
  }
});
