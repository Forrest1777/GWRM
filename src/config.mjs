import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function optionalObject(value, label) {
  if (value === undefined || value === null) return {};
  return assertObject(value, label);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  return requiredString(value, label);
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function optionalInteger(value, fallback, label, min, max) {
  if (value === undefined || value === null) return fallback;
  return integer(value, label, min, max);
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  return booleanValue(value, label);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a list of strings.`);
  }
  return [...value];
}

function optionalStringArray(value, fallback, label) {
  if (value === undefined || value === null) return [...fallback];
  return stringArray(value, label);
}

function enumString(value, fallback, allowed, label) {
  const text = optionalString(value, fallback, label);
  if (!allowed.includes(text)) throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  return text;
}

function resolveAppPath(value) {
  const text = requiredString(value, "path");
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(APP_ROOT, text);
}

export async function loadConfig(configPath) {
  const absoluteConfigPath = path.resolve(configPath || path.join(APP_ROOT, "gwrm.config.json"));
  const raw = await readFile(absoluteConfigPath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));

  if (parsed.schema_version !== 1) throw new Error("schema_version must be 1.");
  const service = assertObject(parsed.service, "service");
  const paths = assertObject(parsed.paths, "paths");
  const ports = assertObject(parsed.ports, "ports");
  const sessions = assertObject(parsed.sessions, "sessions");
  const godot = assertObject(parsed.godot, "godot");
  const godotMcp = assertObject(parsed.godot_mcp, "godot_mcp");
  const gut = assertObject(parsed.gut, "gut");
  const computerUse = optionalObject(parsed.computer_use, "computer_use");

  const config = {
    configPath: absoluteConfigPath,
    appRoot: APP_ROOT,
    service: {
      name: requiredString(service.name, "service.name"),
      mcpPort: integer(service.mcp_port, "service.mcp_port", 1, 65535),
      controlPort: integer(service.control_port, "service.control_port", 1, 65535),
      bindHost: requiredString(service.bind_host, "service.bind_host"),
      apiKey: requiredString(service.api_key, "service.api_key"),
      reconciliationIntervalSeconds: integer(service.reconciliation_interval_seconds, "service.reconciliation_interval_seconds", 5, 3600),
      maxActiveWorktrees: integer(service.max_active_worktrees, "service.max_active_worktrees", 1, 100),
      shutdownTimeoutSeconds: integer(service.shutdown_timeout_seconds, "service.shutdown_timeout_seconds", 1, 120),
    },
    paths: {
      nodeExecutable: requiredString(paths.node_executable, "paths.node_executable"),
      npmExecutable: requiredString(paths.npm_executable, "paths.npm_executable"),
      powershellExecutable: requiredString(paths.powershell_executable, "paths.powershell_executable"),
      godotExecutable: path.normalize(requiredString(paths.godot_executable, "paths.godot_executable")),
      windowsWorkspaceRoot: path.resolve(requiredString(paths.windows_workspace_root, "paths.windows_workspace_root")),
      containerWorkspaceRoot: requiredString(paths.container_workspace_root, "paths.container_workspace_root").replaceAll("\\", "/").replace(/\/+$/, ""),
      windowsWorktreesRoot: path.resolve(requiredString(paths.windows_worktrees_root, "paths.windows_worktrees_root")),
      containerWorktreesRoot: requiredString(paths.container_worktrees_root, "paths.container_worktrees_root").replaceAll("\\", "/").replace(/\/+$/, ""),
      stateDirectory: resolveAppPath(paths.state_directory),
      logsDirectory: resolveAppPath(paths.logs_directory),
    },
    ports: {
      lspStart: integer(ports.lsp_start, "ports.lsp_start", 1024, 65535),
      lspEnd: integer(ports.lsp_end, "ports.lsp_end", 1024, 65535),
      lspProxyStart: integer(ports.lsp_proxy_start, "ports.lsp_proxy_start", 1024, 65535),
      lspProxyEnd: integer(ports.lsp_proxy_end, "ports.lsp_proxy_end", 1024, 65535),
      dapStart: integer(ports.dap_start, "ports.dap_start", 1024, 65535),
      dapEnd: integer(ports.dap_end, "ports.dap_end", 1024, 65535),
    },
    sessions: {
      readyTimeoutSeconds: integer(sessions.ready_timeout_seconds, "sessions.ready_timeout_seconds", 5, 3600),
      inactiveShutdownDelaySeconds: integer(sessions.inactive_shutdown_delay_seconds, "sessions.inactive_shutdown_delay_seconds", 0, 3600),
      restartActiveSessionsAfterCrash: booleanValue(sessions.restart_active_sessions_after_crash, "sessions.restart_active_sessions_after_crash"),
      removeConfigurationWhenWorktreeMissing: booleanValue(sessions.remove_configuration_when_worktree_missing, "sessions.remove_configuration_when_worktree_missing"),
      requireClassCacheBeforeReady: booleanValue(sessions.require_class_cache_before_ready, "sessions.require_class_cache_before_ready"),
    },
    godot: {
      executableArgsPrefix: stringArray(godot.executable_args_prefix, "godot.executable_args_prefix"),
      localReadyHost: requiredString(godot.local_ready_host, "godot.local_ready_host"),
      lspRelayEnabled: booleanValue(godot.lsp_relay_enabled, "godot.lsp_relay_enabled"),
      lspHostForHermes: requiredString(godot.lsp_host_for_hermes, "godot.lsp_host_for_hermes"),
      additionalEditorArgs: stringArray(godot.additional_editor_args, "godot.additional_editor_args"),
    },
    godotMcp: {
      command: requiredString(godotMcp.command, "godot_mcp.command"),
      args: stringArray(godotMcp.args, "godot_mcp.args").map((item) => item.startsWith("./") || item.startsWith(".\\") ? path.resolve(APP_ROOT, item) : item),
      protocolVersion: requiredString(godotMcp.protocol_version, "godot_mcp.protocol_version"),
      startupTimeoutSeconds: integer(godotMcp.startup_timeout_seconds, "godot_mcp.startup_timeout_seconds", 5, 600),
      requestTimeoutSeconds: integer(godotMcp.request_timeout_seconds, "godot_mcp.request_timeout_seconds", 5, 3600),
    },
    gut: {
      defaultTestDirectory: requiredString(gut.default_test_directory, "gut.default_test_directory"),
      allowedTestRoot: requiredString(gut.allowed_test_root, "gut.allowed_test_root"),
      timeoutSeconds: integer(gut.timeout_seconds, "gut.timeout_seconds", 5, 3600),
      maxOutputCharacters: integer(gut.max_output_characters, "gut.max_output_characters", 1000, 1000000),
      maxConcurrentProcesses: integer(gut.max_concurrent_processes, "gut.max_concurrent_processes", 1, 32),
    },
    computerUse: {
      enabled: optionalBoolean(computerUse.enabled, true, "computer_use.enabled"),
      required: optionalBoolean(computerUse.required, false, "computer_use.required"),
      command: optionalString(computerUse.command, "cua-driver", "computer_use.command"),
      args: optionalStringArray(computerUse.args, ["mcp"], "computer_use.args"),
      protocolVersion: optionalString(computerUse.protocol_version, "2024-11-05", "computer_use.protocol_version"),
      startupTimeoutSeconds: optionalInteger(computerUse.startup_timeout_seconds, 20, "computer_use.startup_timeout_seconds", 2, 300),
      requestTimeoutSeconds: optionalInteger(computerUse.request_timeout_seconds, 60, "computer_use.request_timeout_seconds", 2, 600),
      permissionMode: enumString(computerUse.permission_mode, "standard", ["standard", "bounded"], "computer_use.permission_mode"),
      capabilityManifestFile: computerUse.capability_manifest_file ? resolveAppPath(computerUse.capability_manifest_file) : null,
      capabilityManifestApproved: optionalBoolean(computerUse.capability_manifest_approved, false, "computer_use.capability_manifest_approved"),
      waitTimeoutSeconds: optionalInteger(computerUse.wait_timeout_seconds, 15, "computer_use.wait_timeout_seconds", 1, 120),
      maxWaitTimeoutSeconds: optionalInteger(computerUse.max_wait_timeout_seconds, 60, "computer_use.max_wait_timeout_seconds", 1, 300),
      waitPollMilliseconds: optionalInteger(computerUse.wait_poll_milliseconds, 500, "computer_use.wait_poll_milliseconds", 50, 5000),
      maxSemanticElements: optionalInteger(computerUse.max_semantic_elements, 400, "computer_use.max_semantic_elements", 1, 2000),
      maxSemanticDepth: optionalInteger(computerUse.max_semantic_depth, 16, "computer_use.max_semantic_depth", 1, 25),
      maxImageDimension: optionalInteger(computerUse.max_image_dimension, 900, "computer_use.max_image_dimension", 64, 4096),
    },
  };

  if (!/^[A-Fa-f0-9]{64,128}$/.test(config.service.apiKey)) throw new Error("service.api_key must be hexadecimal and contain between 64 and 128 characters.");
  if (config.godotMcp.command === "@node") config.godotMcp.command = config.paths.nodeExecutable;

  if (config.service.mcpPort === config.service.controlPort) throw new Error("service.mcp_port e service.control_port devem ser diferentes.");
  if (config.ports.lspStart > config.ports.lspEnd) throw new Error("Invalid LSP port range.");
  if (config.ports.lspProxyStart > config.ports.lspProxyEnd) throw new Error("Invalid LSP relay port range.");
  if (config.ports.dapStart > config.ports.dapEnd) throw new Error("Invalid DAP port range.");
  if (config.computerUse.waitTimeoutSeconds > config.computerUse.maxWaitTimeoutSeconds) throw new Error("computer_use.wait_timeout_seconds must not exceed max_wait_timeout_seconds.");
  if (config.computerUse.permissionMode === "bounded" && (!config.computerUse.capabilityManifestFile || !config.computerUse.capabilityManifestApproved)) {
    throw new Error("computer_use.permission_mode=bounded exige capability_manifest_file e capability_manifest_approved=true.");
  }
  if (config.paths.containerWorktreesRoot !== config.paths.containerWorkspaceRoot && !config.paths.containerWorktreesRoot.startsWith(`${config.paths.containerWorkspaceRoot}/`)) {
    throw new Error("container_worktrees_root must be inside container_workspace_root.");
  }

  await access(config.paths.godotExecutable);
  await access(config.paths.windowsWorkspaceRoot);
  await access(config.paths.windowsWorktreesRoot);
  return config;
}

export { APP_ROOT };
