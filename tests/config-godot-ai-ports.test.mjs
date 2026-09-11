import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function baseConfig(overrides = {}) {
  const config = {
    schema_version: 1,
    service: {
      name: "GWRM-test",
      mcp_port: 8123,
      control_port: 8130,
      bind_host: "127.0.0.1",
      api_key: API_KEY,
      reconciliation_interval_seconds: 30,
      max_active_worktrees: 2,
      shutdown_timeout_seconds: 5,
    },
    paths: {
      node_executable: process.execPath,
      npm_executable: "npm",
      powershell_executable: "powershell.exe",
      godot_executable: null,
      windows_workspace_root: null,
      container_workspace_root: "/workspace",
      windows_worktrees_root: null,
      container_worktrees_root: "/workspace/skill_system_framework/.worktrees",
      state_directory: "./state",
      logs_directory: "./logs",
    },
    ports: {
      lsp_start: 6100,
      lsp_end: 6199,
      lsp_proxy_start: 7100,
      lsp_proxy_end: 7199,
      dap_start: 6200,
      dap_end: 6299,
    },
    sessions: {
      ready_timeout_seconds: 30,
      inactive_shutdown_delay_seconds: 0,
      restart_active_sessions_after_crash: true,
      remove_configuration_when_worktree_missing: true,
      require_class_cache_before_ready: true,
    },
    godot: {
      executable_args_prefix: [],
      local_ready_host: "127.0.0.1",
      lsp_relay_enabled: true,
      lsp_host_for_hermes: "host.docker.internal",
      additional_editor_args: [],
    },
    godot_mcp: {
      command: process.execPath,
      args: [path.join(root, "tests", "fixtures", "fake-godot-mcp.mjs")],
      protocol_version: "2024-11-05",
      startup_timeout_seconds: 5,
      request_timeout_seconds: 5,
    },
    gut: {
      default_test_directory: "res://tests/skill_system/ai_system",
      allowed_test_root: "res://tests/skill_system/ai_system",
      timeout_seconds: 5,
      max_output_characters: 10000,
      max_concurrent_processes: 1,
    },
  };

  return deepMerge(config, overrides);
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source === undefined ? target : source;
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
      out[key] = deepMerge(target[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function withTempConfig(overrides, run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gwrm-config-godot-ai-"));
  const worktrees = path.join(temp, "worktrees");
  const dummyGodot = path.join(temp, "Godot_console.exe");
  await mkdir(worktrees, { recursive: true });
  await writeFile(dummyGodot, "");

  const config = baseConfig(overrides);
  config.paths.godot_executable = dummyGodot;
  config.paths.windows_workspace_root = temp;
  config.paths.windows_worktrees_root = worktrees;
  config.paths.state_directory = path.join(temp, "state");
  config.paths.logs_directory = path.join(temp, "logs");

  const configPath = path.join(temp, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  try {
    return await run(configPath, config);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("omitted Godot AI port keys load contract defaults", async () => {
  await withTempConfig({}, async (configPath) => {
    const loaded = await loadConfig(configPath);
    assert.equal(loaded.ports.godotAiHttpStart, 18000);
    assert.equal(loaded.ports.godotAiHttpEnd, 18099);
    assert.equal(loaded.ports.godotAiWsStart, 19500);
    assert.equal(loaded.ports.godotAiWsEnd, 19599);
  });
});

test("explicit Godot AI port keys load into camelCase fields", async () => {
  await withTempConfig({
    ports: {
      godot_ai_http_start: 18100,
      godot_ai_http_end: 18149,
      godot_ai_ws_start: 19600,
      godot_ai_ws_end: 19649,
    },
  }, async (configPath) => {
    const loaded = await loadConfig(configPath);
    assert.equal(loaded.ports.godotAiHttpStart, 18100);
    assert.equal(loaded.ports.godotAiHttpEnd, 18149);
    assert.equal(loaded.ports.godotAiWsStart, 19600);
    assert.equal(loaded.ports.godotAiWsEnd, 19649);
  });
});

test("invalid start>end Godot AI ranges throw", async () => {
  await withTempConfig({
    ports: {
      godot_ai_http_start: 18150,
      godot_ai_http_end: 18100,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /Faixa HTTP Godot AI invalida/);
  });

  await withTempConfig({
    ports: {
      godot_ai_ws_start: 19650,
      godot_ai_ws_end: 19600,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /Faixa WS Godot AI invalida/);
  });
});

test("Godot AI ranges must be pairwise disjoint with LSP/DAP/proxy and each other", async () => {
  await withTempConfig({
    ports: {
      godot_ai_http_start: 6150,
      godot_ai_http_end: 6160,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /Faixa HTTP Godot AI e faixa LSP devem ser disjuntas/);
  });

  await withTempConfig({
    ports: {
      godot_ai_ws_start: 6220,
      godot_ai_ws_end: 6230,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /Faixa WS Godot AI e faixa DAP devem ser disjuntas/);
  });

  await withTempConfig({
    ports: {
      godot_ai_http_start: 7120,
      godot_ai_http_end: 7130,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /Faixa HTTP Godot AI e faixa relay LSP devem ser disjuntas/);
  });

  await withTempConfig({
    ports: {
      godot_ai_http_start: 19550,
      godot_ai_http_end: 19560,
      godot_ai_ws_start: 19500,
      godot_ai_ws_end: 19599,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /Faixa HTTP Godot AI e faixa WS Godot AI devem ser disjuntas/);
  });
});

test("Godot AI ranges cannot include mcp/control ports or overlap 8000-8099", async () => {
  await withTempConfig({
    ports: {
      godot_ai_http_start: 8120,
      godot_ai_http_end: 8135,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /service\.mcp_port/);
  });

  await withTempConfig({
    ports: {
      godot_ai_ws_start: 8125,
      godot_ai_ws_end: 8135,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /service\.control_port|service\.mcp_port/);
  });

  await withTempConfig({
    ports: {
      godot_ai_http_start: 8050,
      godot_ai_http_end: 8060,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /8000-8099/);
  });

  await withTempConfig({
    ports: {
      godot_ai_ws_start: 8000,
      godot_ai_ws_end: 8001,
    },
  }, async (configPath) => {
    await assert.rejects(() => loadConfig(configPath), /8000-8099/);
  });
});

test("example and DEFAULT json include Godot AI port keys with contract defaults", async () => {
  const example = JSON.parse((await readFile(path.join(root, "gwrm.config.example.json"), "utf8")).replace(/^\uFEFF/, ""));
  const defaults = JSON.parse((await readFile(path.join(root, "gwrm.config_DEFAULT.json"), "utf8")).replace(/^\uFEFF/, ""));

  for (const [label, doc] of [["example", example], ["DEFAULT", defaults]]) {
    assert.equal(doc.ports.godot_ai_http_start, 18000, `${label} http start`);
    assert.equal(doc.ports.godot_ai_http_end, 18099, `${label} http end`);
    assert.equal(doc.ports.godot_ai_ws_start, 19500, `${label} ws start`);
    assert.equal(doc.ports.godot_ai_ws_end, 19599, `${label} ws end`);
  }
});
