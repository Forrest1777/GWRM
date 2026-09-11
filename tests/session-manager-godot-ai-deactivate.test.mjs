import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../src/logger.mjs";
import { SessionManager } from "../src/session-manager.mjs";
import { GodotAiSessionRegistry } from "../src/godot-ai-session-registry.mjs";
import { GodotAiEditorSettings } from "../src/godot-ai-editor-settings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSettings = path.join(root, "tests", "fixtures", "editor_settings_godot_ai.tres");
const fakeAiPath = path.join(root, "tests", "fixtures", "fake-godot-ai-mcp.mjs");

function buildConfig(temp, worktrees, portBase, sessionOverrides = {}) {
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
      ...sessionOverrides,
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

async function prepareAppData(temp) {
  const appdataDir = path.join(temp, "APPDATA");
  const godotDir = path.join(appdataDir, "Godot");
  await mkdir(godotDir, { recursive: true });
  const settingsPath = path.join(godotDir, "editor_settings-4.tres");
  await copyFile(fixtureSettings, settingsPath);
  return { appdataDir, settingsPath };
}

function createFakeBridgeTracker(options = {}) {
  const attachCalls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  function bridgeFactory({ worktree_name } = {}) {
    return {
      async attach(attachOptions = {}) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        attachCalls.push({
          worktree_name: worktree_name || attachOptions.label,
          httpPort: attachOptions.httpPort,
          wsPort: attachOptions.wsPort,
          label: attachOptions.label,
        });
        try {
          if (typeof options.attachImpl === "function") {
            return await options.attachImpl(attachOptions, worktree_name);
          }
          const label = attachOptions.label || worktree_name || "wt";
          return {
            ok: true,
            session_id: null,
            sessions: [{ session_id: `${label}@session`, name: label }],
          };
        } finally {
          inFlight -= 1;
        }
      },
      async disconnect() {
        return { ok: true, disconnected: true };
      },
      get isConnected() {
        return true;
      },
    };
  }

  return {
    attachCalls,
    get maxInFlight() {
      return maxInFlight;
    },
    bridgeFactory,
  };
}

function createGuiRegistry() {
  /** @type {Map<string, Array<{pid:number, command_line:string, name:string}>>} */
  const byPath = new Map();
  const alive = new Set();

  return {
    byPath,
    alive,
    setHealthy(hostPath, pid) {
      alive.add(pid);
      byPath.set(hostPath, [
        {
          pid,
          name: "Godot.exe",
          command_line: `"C:/Godot/Godot.exe" --path ${hostPath} --editor`,
        },
      ]);
    },
    clear(hostPath) {
      const rows = byPath.get(hostPath) || [];
      for (const row of rows) alive.delete(row.pid);
      byPath.delete(hostPath);
    },
    lister: async (hostPath) => byPath.get(hostPath) || [],
    isPidAlive: (pid) => alive.has(pid),
  };
}

function wrapLaunchCounter(sessions, worktreeName) {
  const runtime = sessions.runtime.get(worktreeName);
  assert.ok(runtime?.mcp, "expected MCP runtime for launch counter");
  let launches = 0;
  const original = runtime.mcp.callTool.bind(runtime.mcp);
  runtime.mcp.callTool = async (toolName, args) => {
    if (toolName === "launch_editor") launches += 1;
    return original(toolName, args);
  };
  return {
    get count() {
      return launches;
    },
  };
}

async function withSessions(temp, worktrees, portBase, dependencyFactory, fn, sessionOverrides = {}) {
  const config = buildConfig(temp, worktrees, portBase, sessionOverrides);
  const logger = new Logger(config.paths.logsDirectory);
  await logger.init();
  const dependencies = dependencyFactory(config);
  const sessions = new SessionManager(config, logger, dependencies);
  await sessions.init();
  try {
    return await fn(sessions, config, dependencies);
  } finally {
    await sessions.shutdown();
  }
}

test("deactivate releases registry before stopRuntime and maps runtime_stopped", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-deact-stop-"));
  const worktrees = path.join(temp, "worktrees");
  const hostPath = await prepareWorktree(worktrees, "t_stop");
  const { appdataDir } = await prepareAppData(temp);
  const originalFixture = await readFile(fixtureSettings, "utf8");
  const gui = createGuiRegistry();
  const bridges = createFakeBridgeTracker();
  const registry = new GodotAiSessionRegistry();
  const releaseEvents = [];

  try {
    await withSessions(temp, worktrees, 47000, () => ({
      godotAiSessionRegistry: registry,
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: gui.lister,
      isPidAlive: (pid) => gui.alive.has(pid),
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        command: process.execPath,
        args: [fakeAiPath],
        httpPort,
        wsPort,
      }),
      godotAiBridgeFactory: bridges.bridgeFactory,
      onGodotAiRelease: (event) => {
        releaseEvents.push(event);
      },
    }), async (sessions) => {
      const activated = await sessions.activateWorktree("t_stop", "test");
      assert.equal(activated.status, "ready");
      assert.equal(activated.godot_ai.status, "session_ready");
      assert.equal(registry.usable("t_stop"), true);
      const sticky = {
        http: activated.godot_ai.http_port,
        ws: activated.godot_ai.ws_port,
        session_id: activated.godot_ai.session_id,
        gui_pid: activated.godot_ai.gui_pid,
      };
      gui.setHealthy(hostPath, sticky.gui_pid);

      const stopped = await sessions.deactivateWorktree("t_stop", "test");
      assert.equal(registry.usable("t_stop"), false);
      assert.equal(registry.resolveUsableSession("t_stop").ok, false);
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.directory_released, true);
      assert.equal(stopped.godot_ai.status, "runtime_stopped");
      assert.equal(stopped.godot_ai.session_id, null);
      assert.equal(stopped.godot_ai.gui_pid, null);
      assert.equal(stopped.godot_ai.http_port, sticky.http);
      assert.equal(stopped.godot_ai.ws_port, sticky.ws);

      assert.ok(releaseEvents.length >= 1, "expected release hook");
      const firstRelease = releaseEvents[0];
      assert.equal(firstRelease.worktree_name, "t_stop");
      assert.equal(firstRelease.record_status, "ready");
      assert.equal(firstRelease.has_runtime, true, "release must happen before #stopRuntime tears down runtime");

      const state = JSON.parse(await readFile(path.join(temp, "state", "t_stop.json"), "utf8"));
      assert.equal(state.godot_ai_http_port, sticky.http);
      assert.equal(state.godot_ai_ws_port, sticky.ws);
      assert.equal(state.godot_ai_session_id, null);
      assert.equal(state.godot_ai_status, "runtime_no_session");
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  const fixtureAfter = await readFile(fixtureSettings, "utf8");
  assert.equal(fixtureAfter, originalFixture, "tracked fixture must not be mutated");
});

test("delayed shutdown: release immediately; runtime_stopped after reconcile due", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-deact-delay-"));
  const worktrees = path.join(temp, "worktrees");
  const hostPath = await prepareWorktree(worktrees, "t_delay");
  const { appdataDir } = await prepareAppData(temp);
  const gui = createGuiRegistry();
  const bridges = createFakeBridgeTracker();
  const registry = new GodotAiSessionRegistry();

  try {
    await withSessions(temp, worktrees, 48000, () => ({
      godotAiSessionRegistry: registry,
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: gui.lister,
      isPidAlive: (pid) => gui.alive.has(pid),
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        command: process.execPath,
        args: [fakeAiPath],
        httpPort,
        wsPort,
      }),
      godotAiBridgeFactory: bridges.bridgeFactory,
    }), async (sessions) => {
      const activated = await sessions.activateWorktree("t_delay", "test");
      assert.equal(activated.godot_ai.status, "session_ready");
      gui.setHealthy(hostPath, activated.godot_ai.gui_pid);
      const sticky = { http: activated.godot_ai.http_port, ws: activated.godot_ai.ws_port };

      const delayed = await sessions.deactivateWorktree("t_delay", "test");
      assert.equal(registry.usable("t_delay"), false);
      assert.equal(delayed.status, "ready", "TODO9 remains ready during delay");
      assert.equal(delayed.desired_active, false);
      assert.equal(delayed.godot_ai.status, "runtime_no_session");
      assert.equal(delayed.godot_ai.session_id, null);
      assert.equal(delayed.godot_ai.gui_pid, null);
      assert.equal(delayed.godot_ai.http_port, sticky.http);
      assert.equal(delayed.godot_ai.ws_port, sticky.ws);
      assert.ok(delayed.shutdown_not_before);

      // Force due immediately and reconcile.
      const record = sessions.records.get("t_delay");
      record.shutdown_not_before = new Date(Date.now() - 1000).toISOString();
      await sessions.reconcileAll("test-due");

      const after = sessions.getStatus("t_delay");
      assert.equal(after.status, "stopped");
      assert.equal(after.directory_released, true);
      assert.equal(after.godot_ai.status, "runtime_stopped");
      assert.equal(after.godot_ai.session_id, null);
      assert.equal(after.godot_ai.gui_pid, null);
      assert.equal(after.godot_ai.http_port, sticky.http);
      assert.equal(after.godot_ai.ws_port, sticky.ws);
    }, { inactiveShutdownDelaySeconds: 3600 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("reconcile keeps session_ready when registry usable and GUI healthy (no extra launch/attach)", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-deact-keep-"));
  const worktrees = path.join(temp, "worktrees");
  const hostPath = await prepareWorktree(worktrees, "t_keep");
  const { appdataDir } = await prepareAppData(temp);
  const gui = createGuiRegistry();
  const bridges = createFakeBridgeTracker();
  const registry = new GodotAiSessionRegistry();

  try {
    await withSessions(temp, worktrees, 49000, () => ({
      godotAiSessionRegistry: registry,
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: gui.lister,
      isPidAlive: (pid) => gui.alive.has(pid),
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        command: process.execPath,
        args: [fakeAiPath],
        httpPort,
        wsPort,
      }),
      godotAiBridgeFactory: bridges.bridgeFactory,
    }), async (sessions) => {
      const activated = await sessions.activateWorktree("t_keep", "test");
      assert.equal(activated.godot_ai.status, "session_ready");
      gui.setHealthy(hostPath, activated.godot_ai.gui_pid);
      const launches = wrapLaunchCounter(sessions, "t_keep");
      const attachBefore = bridges.attachCalls.length;
      const sticky = {
        http: activated.godot_ai.http_port,
        ws: activated.godot_ai.ws_port,
        session_id: activated.godot_ai.session_id,
        gui_pid: activated.godot_ai.gui_pid,
      };

      await sessions.reconcileAll("healthy");
      const after = sessions.getStatus("t_keep");
      assert.equal(after.godot_ai.status, "session_ready");
      assert.equal(after.godot_ai.session_id, sticky.session_id);
      assert.equal(after.godot_ai.gui_pid, sticky.gui_pid);
      assert.equal(after.godot_ai.http_port, sticky.http);
      assert.equal(after.godot_ai.ws_port, sticky.ws);
      assert.equal(launches.count, 0, "no extra launch_editor");
      assert.equal(bridges.attachCalls.length, attachBefore, "no extra attach");
      assert.equal(registry.usable("t_keep"), true);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("reconcile relaunches once with same sticky ports when GUI disappears", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-deact-relaunch-"));
  const worktrees = path.join(temp, "worktrees");
  const hostPath = await prepareWorktree(worktrees, "t_relaunch");
  const { appdataDir, settingsPath } = await prepareAppData(temp);
  const gui = createGuiRegistry();
  const bridges = createFakeBridgeTracker();
  const registry = new GodotAiSessionRegistry();

  try {
    await withSessions(temp, worktrees, 50000, () => ({
      godotAiSessionRegistry: registry,
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: gui.lister,
      isPidAlive: (pid) => gui.alive.has(pid),
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        command: process.execPath,
        args: [fakeAiPath],
        httpPort,
        wsPort,
      }),
      godotAiBridgeFactory: bridges.bridgeFactory,
    }), async (sessions) => {
      const activated = await sessions.activateWorktree("t_relaunch", "test");
      assert.equal(activated.godot_ai.status, "session_ready");
      const sticky = {
        http: activated.godot_ai.http_port,
        ws: activated.godot_ai.ws_port,
        session_id: activated.godot_ai.session_id,
      };
      // GUI disappeared: empty process list / unhealthy persisted pid.
      gui.clear(hostPath);
      const launches = wrapLaunchCounter(sessions, "t_relaunch");
      const attachBefore = bridges.attachCalls.length;

      await sessions.reconcileAll("gui-gone");
      const after = sessions.getStatus("t_relaunch");
      assert.equal(after.status, "ready");
      assert.equal(after.godot_ai.status, "session_ready");
      assert.equal(after.godot_ai.http_port, sticky.http);
      assert.equal(after.godot_ai.ws_port, sticky.ws);
      assert.equal(Number.isInteger(after.godot_ai.gui_pid), true);
      assert.equal(typeof after.godot_ai.session_id, "string");
      assert.equal(launches.count, 1, "exactly one launch_editor");
      assert.equal(bridges.attachCalls.length, attachBefore + 1, "exactly one re-attach");
      assert.equal(registry.usable("t_relaunch"), true);

      const applied = await GodotAiEditorSettings.readPorts({ settingsPath });
      assert.equal(applied.ok, true);
      assert.equal(applied.http_port, sticky.http);
      assert.equal(applied.ws_port, sticky.ws);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("simulated restart: persisted session_id is session_invalid until reconcile reconverges", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-deact-restart-"));
  const worktrees = path.join(temp, "worktrees");
  const hostPath = await prepareWorktree(worktrees, "t_restart");
  const { appdataDir, settingsPath } = await prepareAppData(temp);
  const originalFixture = await readFile(fixtureSettings, "utf8");
  const gui = createGuiRegistry();
  const bridges = createFakeBridgeTracker();

  try {
    const config = buildConfig(temp, worktrees, 51000);
    const logger = new Logger(config.paths.logsDirectory);
    await logger.init();
    const emptyRegistry = new GodotAiSessionRegistry();
    const stickyHttp = config.ports.godotAiHttpStart;
    const stickyWs = config.ports.godotAiWsStart;
    await mkdir(path.join(temp, "state"), { recursive: true });
    const persisted = {
      schema_version: 1,
      worktree_name: "t_restart",
      container_project_path: "/workspace/skill_system_framework/.worktrees/t_restart",
      host_project_path: hostPath,
      desired_active: true,
      status: "ready",
      lsp_port: null,
      godot_lsp_port: null,
      dap_port: null,
      godot_pid: null,
      godot_mcp_pid: null,
      residual_pids: [],
      directory_released: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      ready_at: new Date().toISOString(),
      last_error: null,
      shutdown_not_before: null,
      godot_ai_http_port: stickyHttp,
      godot_ai_ws_port: stickyWs,
      godot_ai_gui_pid: 424242,
      godot_ai_session_id: "t_restart@stale",
      godot_ai_status: "session_ready",
      godot_ai_last_error: null,
    };
    await writeFile(path.join(temp, "state", "t_restart.json"), `${JSON.stringify(persisted, null, 2)}\n`);

    const sessions = new SessionManager(config, logger, {
      godotAiSessionRegistry: emptyRegistry,
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: gui.lister,
      isPidAlive: (pid) => gui.alive.has(pid),
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        command: process.execPath,
        args: [fakeAiPath],
        httpPort,
        wsPort,
      }),
      godotAiBridgeFactory: bridges.bridgeFactory,
    });

    // Skip startup reconcile so we can observe session_invalid from the stale cache first.
    const originalReconcile = sessions.reconcileAll.bind(sessions);
    sessions.reconcileAll = async () => {};
    await sessions.init();
    sessions.reconcileAll = originalReconcile;

    try {
      const before = sessions.getStatus("t_restart");
      assert.equal(before.status, "ready");
      assert.equal(before.godot_ai.status, "session_invalid");
      assert.equal(before.godot_ai.session_id, "t_restart@stale");
      assert.notEqual(before.godot_ai.status, "session_ready");
      assert.equal(emptyRegistry.usable("t_restart"), false);
      assert.equal(before.godot_ai.http_port, stickyHttp);
      assert.equal(before.godot_ai.ws_port, stickyWs);

      await sessions.reconcileAll("restart");
      const after = sessions.getStatus("t_restart");
      assert.equal(after.status, "ready");
      assert.equal(after.godot_ai.status, "session_ready");
      assert.equal(after.godot_ai.http_port, stickyHttp);
      assert.equal(after.godot_ai.ws_port, stickyWs);
      assert.equal(typeof after.godot_ai.session_id, "string");
      assert.notEqual(after.godot_ai.session_id, "t_restart@stale");
      assert.equal(emptyRegistry.usable("t_restart"), true);
      assert.equal(bridges.attachCalls.length, 1);

      const applied = await GodotAiEditorSettings.readPorts({ settingsPath });
      assert.equal(applied.ok, true);
      assert.equal(applied.http_port, stickyHttp);
      assert.equal(applied.ws_port, stickyWs);
    } finally {
      await sessions.shutdown();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  const fixtureAfter = await readFile(fixtureSettings, "utf8");
  assert.equal(fixtureAfter, originalFixture);
});

test("two worktrees: deactivate A does not release or rebind B", { timeout: 40000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-deact-two-"));
  const worktrees = path.join(temp, "worktrees");
  const pathA = await prepareWorktree(worktrees, "t_a");
  const pathB = await prepareWorktree(worktrees, "t_b");
  const { appdataDir } = await prepareAppData(temp);
  const gui = createGuiRegistry();
  const bridges = createFakeBridgeTracker();
  const registry = new GodotAiSessionRegistry();
  const releaseEvents = [];

  try {
    await withSessions(temp, worktrees, 52000, () => ({
      godotAiSessionRegistry: registry,
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: gui.lister,
      isPidAlive: (pid) => gui.alive.has(pid),
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        command: process.execPath,
        args: [fakeAiPath],
        httpPort,
        wsPort,
      }),
      godotAiBridgeFactory: bridges.bridgeFactory,
      onGodotAiRelease: (event) => releaseEvents.push(event),
    }), async (sessions) => {
      const a = await sessions.activateWorktree("t_a", "test");
      const b = await sessions.activateWorktree("t_b", "test");
      assert.equal(a.godot_ai.status, "session_ready");
      assert.equal(b.godot_ai.status, "session_ready");
      gui.setHealthy(pathA, a.godot_ai.gui_pid);
      gui.setHealthy(pathB, b.godot_ai.gui_pid);
      const bBefore = {
        session_id: b.godot_ai.session_id,
        http: b.godot_ai.http_port,
        ws: b.godot_ai.ws_port,
        gui_pid: b.godot_ai.gui_pid,
      };
      const attachBefore = bridges.attachCalls.length;

      const stoppedA = await sessions.deactivateWorktree("t_a", "test");
      assert.equal(stoppedA.status, "stopped");
      assert.equal(stoppedA.godot_ai.status, "runtime_stopped");
      assert.equal(registry.usable("t_a"), false);
      assert.equal(registry.usable("t_b"), true);

      const stillB = sessions.getStatus("t_b");
      assert.equal(stillB.status, "ready");
      assert.equal(stillB.godot_ai.status, "session_ready");
      assert.equal(stillB.godot_ai.session_id, bBefore.session_id);
      assert.equal(stillB.godot_ai.http_port, bBefore.http);
      assert.equal(stillB.godot_ai.ws_port, bBefore.ws);
      assert.equal(stillB.godot_ai.gui_pid, bBefore.gui_pid);
      assert.equal(bridges.attachCalls.length, attachBefore, "deactivate A must not rebind B");
      assert.ok(releaseEvents.every((event) => event.worktree_name === "t_a"));
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
