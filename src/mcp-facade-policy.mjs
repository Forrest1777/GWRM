const SAFE_RETRY_TOOLS = new Set([
  "gwrm_status",
  "get_worktree_status",
  "get_gut_run_status",
  "get_debug_output",
  "get_godot_version",
  "list_projects",
  "get_project_info",
  "gui_status",
  "gui_list_windows",
  "gui_wait_for_window",
  "gui_inspect_window",
  "gui_capture_window",
  "gui_wait_for_element",
]);

export function isSafeToRetrySupervisorTool(name) {
  return SAFE_RETRY_TOOLS.has(name);
}

export function supervisorRequestTimeoutMs(config, name) {
  const bufferSeconds = 30;

  if (name === "run_gut_tests" || name === "run_gut_test_script" || name === "get_gut_run_status") {
    return 60_000;
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

  if (name.startsWith("gui_")) {
    return (config.computerUse.maxWaitTimeoutSeconds + config.computerUse.requestTimeoutSeconds + bufferSeconds) * 1000;
  }

  return 60_000;
}
