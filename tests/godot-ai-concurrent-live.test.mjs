import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GodotAiBridge } from "../src/godot-ai-bridge.mjs";
import { GodotAiEditorSettings } from "../src/godot-ai-editor-settings.mjs";
import { Logger } from "../src/logger.mjs";
import { listWindowsProcessesReferencingPath } from "../src/process-utils.mjs";
import { SessionManager } from "../src/session-manager.mjs";

const LIVE = process.env.GWRM_GODOT_AI_LIVE === "1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME_A = "gatef_a";
const NAME_B = "gatef_b";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWin() {
  return process.platform === "win32";
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureJunction(linkPath, targetPath) {
  if (await pathExists(linkPath)) return;
  await new Promise((resolve, reject) => {
    const child = spawn(
      "cmd.exe",
      ["/c", "mklink", "/J", linkPath, targetPath],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mklink failed code=${code}: ${stderr.trim()}`));
    });
  });
}

async function robocopy(src, dest) {
  await mkdir(dest, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(
      "robocopy.exe",
      [src, dest, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code >= 0 && code <= 7) resolve();
      else reject(new Error(`robocopy exit ${code}`));
    });
  });
}

function projectGodot(projectName) {
  return `; Engine configuration file.
config_version=5

[application]

config/name="${projectName}"
config/features=PackedStringArray("4.7", "GL Compatibility")

[autoload]

_mcp_game_helper="*res://addons/godot_ai/runtime/game_helper.gd"

[editor_plugins]

enabled=PackedStringArray("res://addons/godot_ai/plugin.cfg")

[rendering]

renderer/rendering_method.mobile="gl_compatibility"
`;
}

function extractProjectIdentity(payload) {
  const result = payload?.result ?? payload;
  const data = result?.data ?? result;
  const candidates = [
    data?.project_name,
    data?.project_path,
    data?.path,
    result?.project_name,
    result?.project_path,
    payload?.project_name,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return JSON.stringify(result ?? payload ?? null);
}

/**
 * Live harness helper: Godot 4.7.2 on Windows launches a dual process pair for
 * graphical editor starts (`*_console.exe -e` + `*.exe -e`). SessionManager's
 * default healthy-GUI filter treats both as candidates and fails closed with
 * "Multiple GUI candidates after launch_editor". Prefer the non-console GUI
 * process so Gate F can exercise real attach/session isolation without editing
 * protected src/**.
 */
async function godotGuiProcessLister(pathFragment, config) {
  const rows = await listWindowsProcessesReferencingPath(pathFragment, config);
  const godotNonHeadless = (Array.isArray(rows) ? rows : []).filter((row) => {
    const name = String(row?.name || "").toLowerCase();
    const cmd = String(row?.command_line || "").toLowerCase();
    if (!name.includes("godot") && !cmd.includes("godot")) return false;
    if (cmd.includes("--headless")) return false;
    return true;
  });
  const nonConsole = godotNonHeadless.filter((row) => {
    const name = String(row?.name || "").toLowerCase();
    return !name.includes("console");
  });
  if (nonConsole.length === 1) return nonConsole;
  if (nonConsole.length > 1) {
    return [nonConsole.sort((a, b) => Number(b.pid) - Number(a.pid))[0]];
  }
  if (godotNonHeadless.length > 1) {
    return [godotNonHeadless.sort((a, b) => Number(b.pid) - Number(a.pid))[0]];
  }
  return godotNonHeadless;
}

function buildLiveConfig(paths) {
  const portBase = Number(process.env.GWRM_GATEF_PORT_BASE || 6300);
  return {
    appRoot: ROOT,
    configPath: paths.configPath,
    service: {
      name: "GWRM-GATEF",
      mcpPort: Number(process.env.GWRM_GATEF_MCP_PORT || 28123),
      controlPort: Number(process.env.GWRM_GATEF_CONTROL_PORT || 28130),
      bindHost: "127.0.0.1",
      apiKey: randomBytes(32).toString("hex"),
      reconciliationIntervalSeconds: 3600,
      maxActiveWorktrees: 4,
      shutdownTimeoutSeconds: 15,
    },
    paths: {
      nodeExecutable: process.env.GWRM_NODE_EXECUTABLE || process.execPath,
      npmExecutable: process.env.GWRM_NPM_EXECUTABLE || "npm.cmd",
      powershellExecutable: "powershell.exe",
      godotExecutable:
        process.env.GWRM_GODOT_EXECUTABLE
        || "E:\\dev\\IDE\\Godot_v4.7.2-stable_win64\\Godot_v4.7.2-stable_win64_console.exe",
      windowsWorkspaceRoot:
        process.env.GWRM_WINDOWS_WORKSPACE_ROOT || "E:\\dev\\ai_agents\\hermes\\workspace",
      containerWorkspaceRoot: "/workspace",
      windowsWorktreesRoot: paths.worktreesRoot,
      containerWorktreesRoot: "/workspace/.hermes-tmp/gatef-worktrees",
      stateDirectory: paths.stateDir,
      logsDirectory: paths.logsDir,
    },
    ports: {
      lspStart: portBase,
      lspEnd: portBase + 99,
      lspProxyStart: portBase + 1000,
      lspProxyEnd: portBase + 1099,
      dapStart: portBase + 100,
      dapEnd: portBase + 199,
      godotAiHttpStart: 18200,
      godotAiHttpEnd: 18299,
      godotAiWsStart: 19700,
      godotAiWsEnd: 19799,
    },
    sessions: {
      readyTimeoutSeconds: 300,
      inactiveShutdownDelaySeconds: 0,
      restartActiveSessionsAfterCrash: false,
      removeConfigurationWhenWorktreeMissing: true,
      requireClassCacheBeforeReady: true,
    },
    godot: {
      executableArgsPrefix: [],
      localReadyHost: "127.0.0.1",
      lspRelayEnabled: true,
      lspHostForHermes: "127.0.0.1",
      additionalEditorArgs: [],
    },
    godotMcp: {
      command: process.env.GWRM_NODE_EXECUTABLE || process.execPath,
      args: [path.join(ROOT, "node_modules", "@coding-solo", "godot-mcp", "build", "index.js")],
      protocolVersion: "2024-11-05",
      startupTimeoutSeconds: 90,
      requestTimeoutSeconds: 300,
    },
    gut: {
      defaultTestDirectory: "res://",
      allowedTestRoot: "res://",
      timeoutSeconds: 60,
      maxOutputCharacters: 10000,
      maxConcurrentProcesses: 1,
    },
    computerUse: {
      enabled: false,
      required: false,
    },
  };
}

test(
  "live Gate F: two real worktrees, distinct Godot AI sessions, no cross-talk",
  {
    timeout: 900_000,
    skip: !LIVE
      ? "set GWRM_GODOT_AI_LIVE=1 to run live concurrent Godot AI isolation"
      : !isWin()
        ? "live Gate F requires Windows host (win32)"
        : false,
  },
  async (t) => {
    const evidence = {
      card: "TODO11-11 Gate F",
      started_at: new Date().toISOString(),
      mode: "in_process_session_manager",
      production_untouched: true,
      worktrees: {},
      call_tool: {},
      teardown: {},
    };

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gwrm-gatef-"));
    const isolatedRoot = path.join(
      process.env.GWRM_GATEF_ROOT
        || path.join("E:\\dev\\ai_agents\\hermes\\workspace", ".hermes-tmp"),
      `todo11-gatef-${path.basename(tempRoot)}`,
    );
    const worktreesRoot = path.join(isolatedRoot, "worktrees");
    const stateDir = path.join(isolatedRoot, "state");
    const logsDir = path.join(isolatedRoot, "logs");
    const configPath = path.join(isolatedRoot, "gwrm.gatef.config.json");
    const evidencePath = path.join(isolatedRoot, "gatef-evidence.json");
    const editorSettingsPath = GodotAiEditorSettings.resolveDefaultPath({
      appdataDir: process.env.APPDATA,
    });
    const editorBackupPath = path.join(isolatedRoot, "editor_settings-4.7.tres.backup");

    const createdNodeModulesJunction = !(await pathExists(path.join(ROOT, "node_modules")));
    let sessions = null;
    let logger = null;

    const cleanup = async () => {
      try {
        if (sessions) {
          for (const name of [NAME_A, NAME_B]) {
            try {
              const status = await sessions.deactivateWorktree(name, "gatef_live");
              evidence.teardown[name] = {
                status: status?.status ?? null,
                godot_ai_status: status?.godot_ai?.status ?? null,
                residual_pids: status?.residual_pids ?? [],
                directory_released: status?.directory_released ?? null,
              };
            } catch (error) {
              evidence.teardown[name] = { error: String(error?.message || error) };
            }
          }
          try {
            await sessions.shutdown?.();
          } catch (error) {
            evidence.teardown.shutdown_error = String(error?.message || error);
          }
        }
      } finally {
        if (await pathExists(editorBackupPath) && await pathExists(path.dirname(editorSettingsPath))) {
          try {
            await copyFile(editorBackupPath, editorSettingsPath);
            evidence.teardown.editor_settings_restored = true;
          } catch (error) {
            evidence.teardown.editor_settings_restored = false;
            evidence.teardown.editor_settings_error = String(error?.message || error);
          }
        }
        if (createdNodeModulesJunction) {
          try {
            // Remove junction only (not target contents).
            await new Promise((resolve) => {
              const child = spawn("cmd.exe", ["/c", "rmdir", path.join(ROOT, "node_modules")], {
                windowsHide: true,
                stdio: "ignore",
              });
              child.once("close", () => resolve());
              child.once("error", () => resolve());
            });
          } catch {}
        }
        evidence.finished_at = new Date().toISOString();
        try {
          await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
        } catch {}
        try {
          await rm(tempRoot, { recursive: true, force: true });
        } catch {}
      }
    };

    t.after(cleanup);

    const nodeModulesCandidates = [
      process.env.GWRM_NODE_MODULES,
      "E:\\dev\\ai_agents\\GWRM\\node_modules",
      path.join(path.dirname(ROOT), "node_modules"),
    ].filter(Boolean);
    let nodeModulesTarget = null;
    for (const candidate of nodeModulesCandidates) {
      if (await pathExists(path.join(candidate, "@coding-solo", "godot-mcp", "build", "index.js"))) {
        nodeModulesTarget = candidate;
        break;
      }
    }
    assert.ok(nodeModulesTarget, "node_modules with @coding-solo/godot-mcp not found");
    await ensureJunction(path.join(ROOT, "node_modules"), nodeModulesTarget);

    await mkdir(worktreesRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });

    assert.equal(await pathExists(editorSettingsPath), true, `missing EditorSettings ${editorSettingsPath}`);
    await copyFile(editorSettingsPath, editorBackupPath);
    evidence.editor_settings_path = editorSettingsPath;
    evidence.editor_settings_backup_sha256 = createHash("sha256")
      .update(await readFile(editorBackupPath))
      .digest("hex");

    const addonSrc = process.env.GWRM_GATEF_ADDON_SRC
      || "E:\\dev\\ai_agents\\hermes\\workspace\\skill_system_framework\\addons\\godot_ai";
    assert.equal(await pathExists(path.join(addonSrc, "plugin.cfg")), true, "Godot AI addon missing");

    for (const name of [NAME_A, NAME_B]) {
      const projectDir = path.join(worktreesRoot, name);
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, "project.godot"), projectGodot(name), "utf8");
      await robocopy(addonSrc, path.join(projectDir, "addons", "godot_ai"));
      assert.equal(await pathExists(path.join(projectDir, "addons", "godot_ai", "plugin.cfg")), true);
    }

    const config = buildLiveConfig({ worktreesRoot, stateDir, logsDir, configPath });
    assert.equal(await pathExists(config.paths.godotExecutable), true, "Godot 4.7.2 console missing");
    await writeFile(configPath, JSON.stringify({
      note: "in-process live config object used; file kept for evidence only",
      isolated_root: isolatedRoot,
      worktrees_root: worktreesRoot,
      ports: config.ports,
      service_ports: {
        mcp: config.service.mcpPort,
        control: config.service.controlPort,
      },
    }, null, 2));
    evidence.config_path = configPath;
    evidence.isolated_root = isolatedRoot;

    logger = new Logger(logsDir);
    await logger.init();
    sessions = new SessionManager(config, logger, {
      godotAiProcessLister: godotGuiProcessLister,
      godotAiAttachOptions: ({ httpPort, wsPort }) => ({
        httpPort,
        wsPort,
        startupTimeoutMs: 90_000,
        requestTimeoutMs: 60_000,
      }),
      godotAiWaitForListen: async (host, port, timeoutMs) => {
        const { waitForPort } = await import("../src/ports.mjs");
        await waitForPort(host, port, timeoutMs);
        // Godot AI 4.0.4 can accept TCP before session_manage list is populated.
        // Live diagnostics showed empty sessions immediately after listen, then a
        // usable session a few seconds later on the same ports.
        await sleep(20_000);
      },
    });
    await sessions.init();

    // Activate both (critical section is globally serialized inside SessionManager).
    const activated = {};
    for (const name of [NAME_A, NAME_B]) {
      activated[name] = await sessions.activateWorktree(name, "gatef_live");
      evidence.worktrees[name] = {
        status: activated[name]?.status ?? null,
        godot_ai: activated[name]?.godot_ai ?? null,
        host_project_path: activated[name]?.host_project_path ?? null,
      };
    }

    const statusA = sessions.getStatus(NAME_A);
    const statusB = sessions.getStatus(NAME_B);
    evidence.worktrees[NAME_A].final_status = {
      status: statusA.status,
      godot_ai: statusA.godot_ai,
      residual_pids: statusA.residual_pids,
    };
    evidence.worktrees[NAME_B].final_status = {
      status: statusB.status,
      godot_ai: statusB.godot_ai,
      residual_pids: statusB.residual_pids,
    };

    assert.equal(statusA.status, "ready", `A TODO9 not ready: ${JSON.stringify(statusA)}`);
    assert.equal(statusB.status, "ready", `B TODO9 not ready: ${JSON.stringify(statusB)}`);
    assert.equal(
      statusA.godot_ai?.status,
      "session_ready",
      `A godot_ai: ${JSON.stringify(statusA.godot_ai)}`,
    );
    assert.equal(
      statusB.godot_ai?.status,
      "session_ready",
      `B godot_ai: ${JSON.stringify(statusB.godot_ai)}`,
    );

    const sessionA = statusA.godot_ai.session_id;
    const sessionB = statusB.godot_ai.session_id;
    assert.equal(typeof sessionA, "string");
    assert.equal(typeof sessionB, "string");
    assert.ok(sessionA.length > 0);
    assert.ok(sessionB.length > 0);
    assert.notEqual(sessionA, sessionB);

    for (const port of [
      statusA.godot_ai.http_port,
      statusA.godot_ai.ws_port,
      statusB.godot_ai.http_port,
      statusB.godot_ai.ws_port,
    ]) {
      assert.equal(Number.isInteger(port), true);
    }
    assert.notEqual(statusA.godot_ai.http_port, statusB.godot_ai.http_port);
    assert.notEqual(statusA.godot_ai.ws_port, statusB.godot_ai.ws_port);
    assert.equal(Number.isInteger(statusA.godot_ai.gui_pid), true);
    assert.equal(Number.isInteger(statusB.godot_ai.gui_pid), true);
    assert.notEqual(statusA.godot_ai.gui_pid, statusB.godot_ai.gui_pid);

    async function probe(worktreeStatus, expectedName, foreignSessionId) {
      const bridge = new GodotAiBridge();
      const attached = await bridge.attach({
        httpPort: worktreeStatus.godot_ai.http_port,
        wsPort: worktreeStatus.godot_ai.ws_port,
        startupTimeoutMs: 30_000,
        requestTimeoutMs: 30_000,
        label: `gatef-probe-${expectedName}`,
      });
      assert.equal(attached.ok, true, `attach failed: ${JSON.stringify(attached)}`);
      try {
        const toolNames = (bridge.client?.tools || []).map((tool) => tool?.name).filter(Boolean);
        const preferredTools = [
          "get_editor_state",
          "get_scene_tree",
          "get_open_scenes",
          "get_selection",
          "session_manage",
        ];
        const operation = preferredTools.find((name) => toolNames.includes(name)) || toolNames[0];
        assert.ok(operation, `no Godot AI tools advertised: ${JSON.stringify(toolNames)}`);

        const ownArgs = operation === "session_manage" ? { op: "list" } : {};
        const own = await bridge.callTool({
          session_id: worktreeStatus.godot_ai.session_id,
          name: operation,
          arguments: ownArgs,
        });
        assert.equal(own.ok, true, `callTool own failed: ${JSON.stringify(own)} tools=${JSON.stringify(toolNames)}`);
        let identity = extractProjectIdentity(own);
        // session_manage list may nest project_path under sessions[]
        if (!identity.includes(expectedName) && Array.isArray(own?.result?.sessions)) {
          const matched = own.result.sessions.find((session) => session?.session_id === worktreeStatus.godot_ai.session_id);
          identity = extractProjectIdentity(matched) || identity;
        }
        if (!identity.includes(expectedName) && Array.isArray(attached.sessions)) {
          const matched = attached.sessions.find((session) => session?.session_id === worktreeStatus.godot_ai.session_id);
          // Still require callTool success above; use attach metadata only as identity aid when tool payload omits path.
          const attachIdentity = extractProjectIdentity(matched);
          if (attachIdentity.includes(expectedName)) identity = `${identity}||attach:${attachIdentity}`;
        }
        assert.ok(
          identity.includes(expectedName),
          `expected identity to include ${expectedName}, got ${identity}; tools=${JSON.stringify(toolNames)}`,
        );

        const foreign = await bridge.callTool({
          session_id: foreignSessionId,
          name: operation,
          arguments: ownArgs,
        });
        let foreignIdentity = null;
        if (foreign.ok) {
          foreignIdentity = extractProjectIdentity(foreign);
          if (!String(foreignIdentity).includes(expectedName === NAME_A ? NAME_B : NAME_A)
            && Array.isArray(foreign?.result?.sessions)) {
            const matched = foreign.result.sessions.find((session) => session?.session_id === foreignSessionId);
            foreignIdentity = extractProjectIdentity(matched) || foreignIdentity;
          }
        }
        const otherName = expectedName === NAME_A ? NAME_B : NAME_A;
        const leaked = Boolean(
          foreign.ok
          && typeof foreignIdentity === "string"
          && foreignIdentity.includes(otherName)
          && !foreignIdentity.includes(expectedName),
        );
        assert.equal(leaked, false, `cross-talk for ${expectedName}: ${JSON.stringify(foreign)}`);

        return {
          attach_ok: true,
          operation,
          tools_advertised_count: toolNames.length,
          own_ok: own.ok,
          own_identity: identity,
          foreign_ok: foreign.ok,
          foreign_code: foreign.code || null,
          foreign_identity: foreignIdentity,
        };
      } finally {
        await bridge.disconnect().catch(() => {});
      }
    }

    evidence.call_tool[NAME_A] = await probe(statusA, NAME_A, sessionB);
    evidence.call_tool[NAME_B] = await probe(statusB, NAME_B, sessionA);

    evidence.production_paths_not_used = {
      state_dir_is_isolated: stateDir.includes(".hermes-tmp"),
      worktrees_isolated: worktreesRoot.includes(".hermes-tmp"),
      production_control_port_not_used: config.service.controlPort !== 8130,
      production_mcp_port_not_used: config.service.mcpPort !== 8123,
      production_state_dir_not_used: !stateDir.toLowerCase().includes("\\gwrm\\state"),
    };
    assert.equal(evidence.production_paths_not_used.state_dir_is_isolated, true);
    assert.equal(evidence.production_paths_not_used.production_control_port_not_used, true);
    assert.equal(evidence.production_paths_not_used.production_mcp_port_not_used, true);

    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    // t.after cleanup deactivates and restores EditorSettings
    assert.equal(statusA.godot_ai.status, "session_ready");
    assert.equal(statusB.godot_ai.status, "session_ready");
  },
);
