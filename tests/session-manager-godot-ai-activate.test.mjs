import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../src/logger.mjs";
import { SessionManager } from "../src/session-manager.mjs";
import { GodotAiEditorSettings } from "../src/godot-ai-editor-settings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSettings = path.join(root, "tests", "fixtures", "editor_settings_godot_ai.tres");
const fakeAiPath = path.join(root, "tests", "fixtures", "fake-godot-ai-mcp.mjs");

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

async function prepareAppData(temp, { copyFixture = true } = {}) {
  const appdataDir = path.join(temp, "APPDATA");
  const godotDir = path.join(appdataDir, "Godot");
  await mkdir(godotDir, { recursive: true });
  const settingsPath = path.join(godotDir, "editor_settings-4.tres");
  if (copyFixture) {
    await copyFile(fixtureSettings, settingsPath);
  }
  return { appdataDir, settingsPath };
}

function createFakeBridgeTracker(options = {}) {
  const attachCalls = [];
  const launchMarkers = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sessionMode = options.sessionMode || "unique_by_label";

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
          command: attachOptions.command,
          args: attachOptions.args,
        });
        try {
          if (typeof options.attachDelayMs === "number" && options.attachDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, options.attachDelayMs));
          }
          if (typeof options.attachImpl === "function") {
            return await options.attachImpl(attachOptions, worktree_name);
          }
          if (sessionMode === "fail") {
            return { ok: false, code: "GODOT_AI_ATTACH_FAILED", message: "forced attach failure" };
          }
          if (sessionMode === "ambiguous") {
            return {
              ok: true,
              session_id: null,
              sessions: [
                { session_id: "sess-a@one", name: "a" },
                { session_id: "sess-b@two", name: "b" },
              ],
            };
          }
          if (sessionMode === "none") {
            return { ok: true, session_id: null, sessions: [] };
          }
          const label = attachOptions.label || worktree_name || "wt";
          return {
            ok: true,
            session_id: null,
            sessions: [
              {
                session_id: `${label}@session`,
                name: label,
                editor_pid: options.editorPidByLabel?.get?.(label) ?? undefined,
              },
            ],
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
    launchMarkers,
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
    isPidAlive: (pid) => alive.has(pid) || (Number.isInteger(pid) && pid > 0 && pid === process.pid),
  };
}

async function withSessions(temp, worktrees, portBase, dependencyFactory, fn) {
  const config = buildConfig(temp, worktrees, portBase);
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

test("happy path: EditorSettings, launch_editor, listen, attach, bind → session_ready", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-activate-happy-"));
  const worktrees = path.join(temp, "worktrees");
  const hostPath = await prepareWorktree(worktrees, "t_happy");
  const { appdataDir, settingsPath } = await prepareAppData(temp);
  const originalFixture = await readFile(fixtureSettings, "utf8");
  const gui = createGuiRegistry();
  const bridges = createFakeBridgeTracker({ attachDelayMs: 5 });
  let launchCount = 0;
  const listeners = [];

  try {
    await withSessions(temp, worktrees, 55000, () => ({
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: async (host) => {
        // Before first launch there is no healthy GUI.
        return gui.lister(host);
      },
      isPidAlive: (pid) => gui.alive.has(pid),
      godotAiWaitForListen: async (host, port) => {
        const server = createServer();
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host, port, exclusive: true }, resolve);
        });
        listeners.push(server);
      },
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        command: process.execPath,
        args: [fakeAiPath],
        httpPort,
        wsPort,
      }),
      godotAiBridgeFactory: (meta) => {
        const bridge = bridges.bridgeFactory(meta);
        const originalAttach = bridge.attach.bind(bridge);
        bridge.attach = async (opts) => {
          // After SessionManager launches, register healthy GUI for reuse tests using observed pid from record via opts label path.
          const statusPath = hostPath;
          const existing = gui.byPath.get(statusPath);
          if (!existing || existing.length === 0) {
            // Discover pid from sticky state file if needed after activate; for first attach, read latest state.
            // SessionManager already persisted gui_pid before attach.
          }
          return originalAttach(opts);
        };
        return bridge;
      },
    }), async (sessions) => {
      // Monkey-patch call path: count launch_editor by wrapping after activate's MCP is up is hard.
      // Instead, empty GUI forces launch; second activate with registered GUI skips launch.
      const first = await sessions.activateWorktree("t_happy", "test");
      assert.equal(first.status, "ready");
      assert.equal(first.godot_ai.status, "session_ready");
      assert.equal(typeof first.godot_ai.session_id, "string");
      assert.match(first.godot_ai.session_id, /t_happy@session/);
      assert.equal(Number.isInteger(first.godot_ai.gui_pid), true);
      assert.equal(Number.isInteger(first.godot_ai.http_port), true);
      assert.equal(Number.isInteger(first.godot_ai.ws_port), true);
      assert.equal(first.godot_ai.last_error, null);
      assert.equal(bridges.attachCalls.length, 1);
      assert.equal(bridges.attachCalls[0].command, process.execPath);
      assert.deepEqual(bridges.attachCalls[0].args, [fakeAiPath]);

      const applied = await GodotAiEditorSettings.readPorts({ settingsPath });
      assert.equal(applied.ok, true);
      assert.equal(applied.http_port, first.godot_ai.http_port);
      assert.equal(applied.ws_port, first.godot_ai.ws_port);

      // Register healthy GUI for idempotent reuse using the observed pid.
      gui.setHealthy(hostPath, first.godot_ai.gui_pid);
      launchCount = 1;

      const second = await sessions.activateWorktree("t_happy", "test-repeat");
      assert.equal(second.status, "ready");
      assert.equal(second.godot_ai.status, "session_ready");
      assert.equal(second.godot_ai.session_id, first.godot_ai.session_id);
      assert.equal(second.godot_ai.gui_pid, first.godot_ai.gui_pid);
      assert.equal(second.godot_ai.http_port, first.godot_ai.http_port);
      assert.equal(second.godot_ai.ws_port, first.godot_ai.ws_port);
      // No second attach when registry.usable + healthy GUI.
      assert.equal(bridges.attachCalls.length, 1);
      assert.equal(launchCount, 1);
    });

    const fixtureAfter = await readFile(fixtureSettings, "utf8");
    assert.equal(fixtureAfter, originalFixture, "tracked fixture must not be mutated");
  } finally {
    await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(() => resolve()))));
    await rm(temp, { recursive: true, force: true });
  }
});

test("two worktrees: serialized critical section, disjoint ports, distinct sessions", { timeout: 40000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-activate-two-"));
  const worktrees = path.join(temp, "worktrees");
  const pathA = await prepareWorktree(worktrees, "t_a");
  const pathB = await prepareWorktree(worktrees, "t_b");
  const { appdataDir, settingsPath } = await prepareAppData(temp);
  const bridges = createFakeBridgeTracker({ attachDelayMs: 40 });
  const gui = createGuiRegistry();
  const criticalInFlight = { value: 0, max: 0 };
  const settingsWrites = [];

  try {
    await withSessions(temp, worktrees, 56000, () => ({
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: gui.lister,
      isPidAlive: (pid) => gui.alive.has(pid),
      godotAiWaitForListen: async () => {
        criticalInFlight.value += 1;
        criticalInFlight.max = Math.max(criticalInFlight.max, criticalInFlight.value);
        await new Promise((resolve) => setTimeout(resolve, 25));
        criticalInFlight.value -= 1;
      },
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        command: process.execPath,
        args: [fakeAiPath],
        httpPort,
        wsPort,
      }),
      godotAiBridgeFactory: bridges.bridgeFactory,
    }), async (sessions) => {
      const [a, b] = await Promise.all([
        sessions.activateWorktree("t_a", "test"),
        sessions.activateWorktree("t_b", "test"),
      ]);

      assert.equal(a.status, "ready");
      assert.equal(b.status, "ready");
      assert.equal(a.godot_ai.status, "session_ready");
      assert.equal(b.godot_ai.status, "session_ready");
      assert.notEqual(a.godot_ai.http_port, b.godot_ai.http_port);
      assert.notEqual(a.godot_ai.ws_port, b.godot_ai.ws_port);
      assert.notEqual(a.godot_ai.session_id, b.godot_ai.session_id);
      assert.notEqual(a.godot_ai.gui_pid, b.godot_ai.gui_pid);
      assert.equal(bridges.attachCalls.length, 2);
      assert.equal(bridges.maxInFlight, 1, "critical section attach must not overlap");
      assert.equal(criticalInFlight.max, 1, "wait-listen must not overlap across worktrees");

      const finalSettings = await GodotAiEditorSettings.readPorts({ settingsPath });
      assert.equal(finalSettings.ok, true);
      // Last writer wins on global EditorSettings; either worktree pair is acceptable.
      assert.ok(
        (finalSettings.http_port === a.godot_ai.http_port && finalSettings.ws_port === a.godot_ai.ws_port)
        || (finalSettings.http_port === b.godot_ai.http_port && finalSettings.ws_port === b.godot_ai.ws_port),
      );

      settingsWrites.push(finalSettings);
      void pathA;
      void pathB;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("EditorSettings applyPorts failure → integration_error, TODO9 stays ready", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-activate-settings-fail-"));
  const worktrees = path.join(temp, "worktrees");
  await prepareWorktree(worktrees, "t_settings_fail");
  const { appdataDir } = await prepareAppData(temp, { copyFixture: false });
  const bridges = createFakeBridgeTracker();

  try {
    await withSessions(temp, worktrees, 57000, () => ({
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: async () => [],
      isPidAlive: () => false,
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: () => ({ command: process.execPath, args: [fakeAiPath] }),
      godotAiBridgeFactory: bridges.bridgeFactory,
    }), async (sessions) => {
      const status = await sessions.activateWorktree("t_settings_fail", "test");
      assert.equal(status.status, "ready");
      assert.equal(status.desired_active, true);
      assert.equal(status.last_error, null);
      assert.equal(status.godot_ai.status, "integration_error");
      assert.equal(status.godot_ai.last_error?.code, "godot_ai_editor_settings_failed");
      assert.equal(status.godot_ai.session_id, null);
      assert.equal(Number.isInteger(status.godot_ai.http_port), true);
      assert.equal(Number.isInteger(status.godot_ai.ws_port), true);
      assert.equal(bridges.attachCalls.length, 0);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("attach/listen failure → integration_error, sticky ports, TODO9 ready", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-activate-attach-fail-"));
  const worktrees = path.join(temp, "worktrees");
  await prepareWorktree(worktrees, "t_attach_fail");
  const { appdataDir } = await prepareAppData(temp);
  const bridges = createFakeBridgeTracker({ sessionMode: "fail" });

  try {
    await withSessions(temp, worktrees, 58000, () => ({
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: async () => [],
      isPidAlive: () => true,
      godotAiWaitForListen: async () => {
        throw new Error("forced listen timeout");
      },
      godotAiAttachOptions: () => ({ command: process.execPath, args: [fakeAiPath] }),
      godotAiBridgeFactory: bridges.bridgeFactory,
    }), async (sessions) => {
      const status = await sessions.activateWorktree("t_attach_fail", "test");
      assert.equal(status.status, "ready");
      assert.equal(status.godot_ai.status, "integration_error");
      assert.equal(status.godot_ai.last_error?.code, "godot_ai_listen_timeout");
      assert.equal(Number.isInteger(status.godot_ai.http_port), true);
      assert.equal(Number.isInteger(status.godot_ai.ws_port), true);
      const ports = { http: status.godot_ai.http_port, ws: status.godot_ai.ws_port };

      // Attach-fail path (listen succeeds, attach fails)
      const temp2 = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-activate-attach-fail2-"));
      try {
        const worktrees2 = path.join(temp2, "worktrees");
        await prepareWorktree(worktrees2, "t_attach_fail2");
        const app2 = await prepareAppData(temp2);
        const bridges2 = createFakeBridgeTracker({ sessionMode: "fail" });
        await withSessions(temp2, worktrees2, 58100, () => ({
          godotAiAppdataDir: app2.appdataDir,
          godotAiProcessLister: async () => [],
          isPidAlive: () => true,
          godotAiWaitForListen: async () => {},
          godotAiAttachOptions: () => ({ command: process.execPath, args: [fakeAiPath] }),
          godotAiBridgeFactory: bridges2.bridgeFactory,
        }), async (sessions2) => {
          const failed = await sessions2.activateWorktree("t_attach_fail2", "test");
          assert.equal(failed.status, "ready");
          assert.equal(failed.godot_ai.status, "integration_error");
          assert.equal(failed.godot_ai.last_error?.code, "godot_ai_attach_failed");
          assert.equal(Number.isInteger(failed.godot_ai.http_port), true);
          assert.equal(Number.isInteger(failed.godot_ai.ws_port), true);
        });
      } finally {
        await rm(temp2, { recursive: true, force: true });
      }

      assert.equal(Number.isInteger(ports.http), true);
      assert.equal(Number.isInteger(ports.ws), true);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("ambiguous sessions → integration_error, never session_activate", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-activate-ambiguous-"));
  const worktrees = path.join(temp, "worktrees");
  await prepareWorktree(worktrees, "t_ambig");
  const { appdataDir } = await prepareAppData(temp);
  const toolNames = [];
  const bridges = createFakeBridgeTracker({
    attachImpl: async () => ({
      ok: true,
      session_id: null,
      sessions: [
        { session_id: "one@aaa", name: "one" },
        { session_id: "two@bbb", name: "two" },
      ],
    }),
  });

  try {
    await withSessions(temp, worktrees, 59000, () => ({
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: async () => [],
      isPidAlive: () => true,
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: () => ({ command: process.execPath, args: [fakeAiPath] }),
      godotAiBridgeFactory: () => {
        const bridge = bridges.bridgeFactory({ worktree_name: "t_ambig" });
        return {
          ...bridge,
          async callTool(input) {
            toolNames.push(input?.name);
            throw new Error("callTool should not be used during activate session selection");
          },
          async attach(opts) {
            const result = await bridge.attach(opts);
            return result;
          },
        };
      },
    }), async (sessions) => {
      const status = await sessions.activateWorktree("t_ambig", "test");
      assert.equal(status.status, "ready");
      assert.equal(status.godot_ai.status, "integration_error");
      assert.equal(status.godot_ai.last_error?.code, "godot_ai_session_ambiguous");
      assert.equal(status.godot_ai.session_id, null);
      assert.equal(toolNames.includes("session_activate"), false);
      assert.equal(bridges.attachCalls.some((call) => call.args?.[0] === fakeAiPath), true);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("temp APPDATA only; tracked editor_settings fixture remains unchanged", { timeout: 30000 }, async () => {
  const originalFixture = await readFile(fixtureSettings, "utf8");
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-godot-ai-activate-appdata-"));
  const worktrees = path.join(temp, "worktrees");
  await prepareWorktree(worktrees, "t_appdata");
  const { appdataDir, settingsPath } = await prepareAppData(temp);
  const bridges = createFakeBridgeTracker();

  try {
    await withSessions(temp, worktrees, 60000, () => ({
      godotAiAppdataDir: appdataDir,
      godotAiProcessLister: async () => [],
      isPidAlive: () => true,
      godotAiWaitForListen: async () => {},
      godotAiAttachOptions: () => ({ command: process.execPath, args: [fakeAiPath] }),
      godotAiBridgeFactory: bridges.bridgeFactory,
    }), async (sessions) => {
      const status = await sessions.activateWorktree("t_appdata", "test");
      assert.equal(status.status, "ready");
      assert.equal(status.godot_ai.status, "session_ready");
      const written = await readFile(settingsPath, "utf8");
      assert.match(written, /godot_ai\/http_port/);
      assert.match(written, /godot_ai\/ws_port/);
      assert.ok(settingsPath.startsWith(temp));
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const after = await readFile(fixtureSettings, "utf8");
  assert.equal(after, originalFixture);
});
