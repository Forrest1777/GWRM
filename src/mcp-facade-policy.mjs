const SAFE_RETRY_TOOLS = new Set([
  "gwrm_status",
  "get_worktree_status",
  "get_debug_output",
  "get_godot_version",
  "list_projects",
  "get_project_info",
]);

export function isSafeToRetrySupervisorTool(name) {
  return SAFE_RETRY_TOOLS.has(name);
}

export function supervisorRequestTimeoutMs(config, name) {
  const bufferSeconds = 30;

  if (name === "run_gut_tests" || name === "run_gut_test_script") {
    return (config.gut.timeoutSeconds + bufferSeconds) * 1000;
  }

  if (name === "activate_worktree") {
    return (config.sessions.readyTimeoutSeconds + bufferSeconds) * 1000;
  }

  if (name === "deactivate_worktree") {
    return (config.service.shutdownTimeoutSeconds + bufferSeconds) * 1000;
  }

  if (
    name === "launch_editor" ||
    name === "run_project" ||
    name === "stop_project" ||
    name === "create_scene" ||
    name === "add_node" ||
    name === "load_sprite" ||
    name === "export_mesh_library" ||
    name === "save_scene" ||
    name === "get_uid" ||
    name === "update_project_uids"
  ) {
    return (config.godotMcp.requestTimeoutSeconds + bufferSeconds) * 1000;
  }

  return 60_000;
}
