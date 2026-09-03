const worktree = { type: "string", description: "Worktree name, for example t_a74adce7." };
const string = (description) => ({ type: "string", description });
const integer = (description, minimum = undefined, maximum = undefined) => ({
  type: "integer",
  description,
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
});

function tool(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

const deliveryMode = { type: "string", enum: ["background", "foreground"], description: "Use background by default; use foreground only as an explicit escalation when required." };

export function buildTools() {
  return [
    tool("gwrm_status", "Shows overall GWRM status, Computer Use status, and all registered worktrees."),
    tool("activate_worktree", "Marks a worktree active and waits for headless Godot/LSP and the dedicated Godot MCP to become ready.", { worktree_name: worktree }, ["worktree_name"]),
    tool("deactivate_worktree", "Marks a worktree inactive and stops its services.", { worktree_name: worktree }, ["worktree_name"]),
    tool("get_worktree_status", "Shows processes, ports, and state for a worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("run_gut_tests", "Starts a supervised GUT directory run and immediately returns operation_id. Query get_gut_run_status until terminal=true.", {
      worktree_name: worktree,
      test_directory: string("res:// directory inside the allowed test root."),
    }, ["worktree_name"]),
    tool("run_gut_test_script", "Starts a supervised single-script GUT run and immediately returns operation_id. Query get_gut_run_status until terminal=true.", {
      worktree_name: worktree,
      test_script: string("Full res:// path to the test script."),
    }, ["worktree_name", "test_script"]),
    tool("get_gut_run_status", "Queries a supervised GUT run. When terminal=true, result contains the final result or error describes the failure.", {
      operation_id: string("operation_id returned by run_gut_tests or run_gut_test_script."),
    }, ["operation_id"]),
    tool("launch_editor", "Forwards launch_editor to the worktree dedicated Godot MCP. It may open an additional graphical editor.", { worktree_name: worktree }, ["worktree_name"]),
    tool("run_project", "Runs the project/scene graphically through the worktree dedicated Godot MCP.", { worktree_name: worktree, scene: string("Optional scene path relative to the project.") }, ["worktree_name"]),
    tool("get_debug_output", "Returns run_project output belonging only to this worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("stop_project", "Stops only the run_project process controlled by this worktree dedicated Godot MCP.", { worktree_name: worktree }, ["worktree_name"]),
    tool("get_godot_version", "Returns the Godot version through the worktree dedicated MCP.", { worktree_name: worktree }, ["worktree_name"]),
    tool("list_projects", "Lists projects from the specified worktree root.", { worktree_name: worktree, recursive: { type: "boolean" } }, ["worktree_name"]),
    tool("get_project_info", "Returns Godot project information for the worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("create_scene", "Creates a scene in the worktree project.", {
      worktree_name: worktree,
      scene_path: string("Scene path relative to the project."),
      root_node_type: string("Root node type; defaults to Node2D."),
    }, ["worktree_name", "scene_path"]),
    tool("add_node", "Adds a node to a worktree scene.", {
      worktree_name: worktree,
      scene_path: string("Scene path relative to the project."),
      parent_node_path: string("Optional parent node path."),
      node_type: string("Godot node type."),
      node_name: string("New node name."),
      properties: { type: "object", description: "Optional properties." },
    }, ["worktree_name", "scene_path", "node_type", "node_name"]),
    tool("load_sprite", "Loads a texture into a Sprite2D in a worktree scene.", {
      worktree_name: worktree,
      scene_path: string("Scene path relative to the project."),
      node_path: string("Sprite2D node path."),
      texture_path: string("Texture path relative to the project."),
    }, ["worktree_name", "scene_path", "node_path", "texture_path"]),
    tool("export_mesh_library", "Exports a worktree scene as a MeshLibrary.", {
      worktree_name: worktree,
      scene_path: string(".tscn scene path relative to the project."),
      output_path: string("Destination .res path."),
      mesh_item_names: { type: "array", items: { type: "string" } },
    }, ["worktree_name", "scene_path", "output_path"]),
    tool("save_scene", "Saves a worktree scene, optionally to a new path.", {
      worktree_name: worktree,
      scene_path: string("Scene path relative to the project."),
      new_path: string("Optional new path."),
    }, ["worktree_name", "scene_path"]),
    tool("get_uid", "Returns the UID of a worktree file.", { worktree_name: worktree, file_path: string("File path relative to the project.") }, ["worktree_name", "file_path"]),
    tool("update_project_uids", "Resaves resources to update UIDs in the worktree project.", { worktree_name: worktree }, ["worktree_name"]),

    tool("gui_status", "Shows the Computer Use/Cua Driver status supervised by GWRM."),
    tool("gui_list_windows", "Lists only authorized graphical Godot windows belonging to processes associated with the worktree.", {
      worktree_name: worktree,
      on_screen_only: { type: "boolean", description: "When true, returns only windows currently on screen." },
    }, ["worktree_name"]),
    tool("gui_wait_for_window", "Waits internally for a graphical Godot window for the worktree, avoiding agent-side polling.", {
      worktree_name: worktree,
      title_contains: string("Optional title substring filter."),
      on_screen_only: { type: "boolean" },
      timeout_seconds: integer("Internal timeout.", 1, 300),
    }, ["worktree_name"]),
    tool("gui_inspect_window", "Semantically inspects a window. By default it does not capture a screenshot, reducing image-token usage.", {
      worktree_name: worktree,
      window_id: integer("window_id returned by gui_list_windows/gui_wait_for_window.", 1),
      query: string("Optional text filter to reduce the accessibility tree."),
      max_elements: integer("Semantic tree element limit.", 1, 2000),
      max_depth: integer("Maximum depth.", 1, 25),
    }, ["worktree_name", "window_id"]),
    tool("gui_capture_window", "Captures visual evidence on demand for an authorized window. Use only when semantic inspection is insufficient.", {
      worktree_name: worktree,
      window_id: integer("Authorized window_id.", 1),
      max_dimension: integer("Maximum image dimension.", 64, 4096),
    }, ["worktree_name", "window_id"]),
    tool("gui_wait_for_element", "Waits internally for a semantic element to appear in the window, without screenshots or agent-side polling.", {
      worktree_name: worktree,
      window_id: integer("Authorized window_id.", 1),
      query: string("Text/label to search for in the accessibility tree."),
      timeout_seconds: integer("Internal timeout.", 1, 300),
      max_elements: integer("Semantic tree element limit.", 1, 2000),
      max_depth: integer("Maximum depth.", 1, 25),
    }, ["worktree_name", "window_id", "query"]),
    tool("gui_click", "Clicks a semantic element or window-local coordinates. Background is the default delivery mode.", {
      worktree_name: worktree,
      window_id: integer("Authorized window_id.", 1),
      element_token: string("Opaque token returned by gui_inspect_window; preferred."),
      element_index: integer("Element index from the snapshot.", 0),
      snapshot_id: string("Snapshot corresponding to element_index."),
      x: { type: "number" }, y: { type: "number" },
      button: { type: "string", enum: ["left", "right", "middle"] },
      modifier: { type: "array", items: { type: "string" } },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id"]),
    tool("gui_type_text", "Inserts text into an element/field in the authorized window.", {
      worktree_name: worktree,
      window_id: integer("Authorized window_id.", 1),
      text: string("Text to insert."),
      element_token: string("Preferred semantic token."),
      element_index: integer("Element index.", 0),
      snapshot_id: string("Corresponding snapshot."),
      x: { type: "number" }, y: { type: "number" },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id", "text"]),
    tool("gui_press_key", "Presses a key in the authorized window.", {
      worktree_name: worktree,
      window_id: integer("Authorized window_id.", 1),
      key: string("Key name: return, tab, escape, space, arrows, letters, etc."),
      modifiers: { type: "array", items: { type: "string" } },
      element_token: string("Optional semantic token."),
      element_index: integer("Element index.", 0),
      snapshot_id: string("Corresponding snapshot."),
      x: { type: "number" }, y: { type: "number" },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id", "key"]),
    tool("gui_hotkey", "Sends a keyboard shortcut to the authorized window.", {
      worktree_name: worktree,
      window_id: integer("Authorized window_id.", 1),
      keys: { type: "array", minItems: 2, items: { type: "string" } },
      element_token: string("Optional semantic token."),
      element_index: integer("Element index.", 0),
      snapshot_id: string("Corresponding snapshot."),
      x: { type: "number" }, y: { type: "number" },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id", "keys"]),
    tool("gui_scroll", "Scrolls the authorized window or element.", {
      worktree_name: worktree,
      window_id: integer("Authorized window_id.", 1),
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: integer("Number of steps/notches.", 1, 50),
      by: { type: "string", enum: ["line", "page"] },
      element_token: string("Optional semantic token."),
      element_index: integer("Element index.", 0),
      snapshot_id: string("Corresponding snapshot."),
      x: { type: "number" }, y: { type: "number" },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id", "direction"]),
  ];
}

const GODOT_TOOLS = new Set([
  "launch_editor", "run_project", "get_debug_output", "stop_project", "get_godot_version", "list_projects", "get_project_info",
  "create_scene", "add_node", "load_sprite", "export_mesh_library", "save_scene", "get_uid", "update_project_uids",
]);

export function buildToolHandler(config, sessionManager, gutRunner, computerUse) {
  return async (name, args) => {
    if (name === "gwrm_status") return {
      ready: true,
      service: config.service.name,
      version: "1.1.0",
      config_file: config.configPath,
      reconciliation_interval_seconds: config.service.reconciliationIntervalSeconds,
      max_active_worktrees: config.service.maxActiveWorktrees,
      computer_use: computerUse.getStatus(),
      worktrees: sessionManager.listStatuses(),
    };
    if (name === "activate_worktree") return await sessionManager.activateWorktree(args.worktree_name, "mcp");
    if (name === "deactivate_worktree") return await sessionManager.deactivateWorktree(args.worktree_name, "mcp");
    if (name === "get_worktree_status") return sessionManager.getStatus(args.worktree_name);
    if (name === "run_gut_tests") return gutRunner.startDirectory(args.worktree_name, args.test_directory);
    if (name === "run_gut_test_script") return gutRunner.startScript(args.worktree_name, args.test_script);
    if (name === "get_gut_run_status") return gutRunner.getOperation(args.operation_id);
    if (GODOT_TOOLS.has(name)) return await sessionManager.callGodotTool(args.worktree_name, name, args);

    if (name === "gui_status") return computerUse.getStatus();
    if (name === "gui_list_windows") return await computerUse.listWindows(args.worktree_name, { onScreenOnly: args.on_screen_only });
    if (name === "gui_wait_for_window") return await computerUse.waitForWindow(args.worktree_name, {
      titleContains: args.title_contains,
      onScreenOnly: args.on_screen_only,
      timeoutSeconds: args.timeout_seconds,
    });
    if (name === "gui_inspect_window") return await computerUse.inspectWindow(args.worktree_name, args.window_id, {
      query: args.query,
      maxElements: args.max_elements,
      maxDepth: args.max_depth,
    });
    if (name === "gui_capture_window") return await computerUse.captureWindow(args.worktree_name, args.window_id, { maxDimension: args.max_dimension });
    if (name === "gui_wait_for_element") return await computerUse.waitForElement(args.worktree_name, args.window_id, args.query, {
      timeoutSeconds: args.timeout_seconds,
      maxElements: args.max_elements,
      maxDepth: args.max_depth,
    });
    if (name === "gui_click") return await computerUse.click(args.worktree_name, args.window_id, args);
    if (name === "gui_type_text") return await computerUse.typeText(args.worktree_name, args.window_id, args);
    if (name === "gui_press_key") return await computerUse.pressKey(args.worktree_name, args.window_id, args);
    if (name === "gui_hotkey") return await computerUse.hotkey(args.worktree_name, args.window_id, args);
    if (name === "gui_scroll") return await computerUse.scroll(args.worktree_name, args.window_id, args);
    throw new Error(`Unknown tool: ${name}`);
  };
}
