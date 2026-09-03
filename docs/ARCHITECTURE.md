# GWRM Architecture

GWRM (Godot Worktree Runtime Manager) is a Windows-hosted gateway that gives a containerized Hermes agent one stable integration boundary for Godot runtime services.

## Runtime topology

```text
Hermes / Docker
  |-- MCP ------------------------> host.docker.internal:8123/mcp
  |                                  |
  |                                  v
  |                              mcp-proxy
  |                                  |
  |                                  v
  |                              GWRM MCP facade
  |
  `-- dynamic GDScript LSP ------> GWRM Control API :8130
                                     |
                                     v
Windows host                      GWRM supervisor
  |
  |-- SessionManager
  |    `-- per active worktree
  |         |-- persistent Godot --headless --editor
  |         |    |-- internal LSP port
  |         |    |-- external LSP relay
  |         |    `-- dedicated DAP port
  |         `-- dedicated @coding-solo/godot-mcp stdio process
  |
  |-- GutRunner
  |    `-- short-lived Godot --headless test processes
  |
  `-- ComputerUseService
       `-- cua-driver mcp (owned child process)
            `-- interactive Windows desktop
                 `-- graphical Godot windows launched by run_project/launch_editor
```

## One user-facing lifecycle

The launcher owns the supervisor and MCP proxy. The supervisor owns worktree runtime services and the Cua Driver MCP transport. A user starts the stack once with `start-gwrm.bat` and stops it with `CTRL+C`.

Computer Use is not a second service the user must manage. On Windows, GWRM starts `cua-driver mcp` as a child process. Closing its stdio transport during GWRM shutdown releases the Cua runtime.

## Worktree isolation

Every runtime call identifies a `worktree_name`. GWRM maps it to configured Windows/container roots and refuses paths that escape those roots.

An active worktree owns:

- a persistent headless Godot editor for import/cache/LSP/DAP;
- a dedicated Godot MCP process;
- dynamically allocated LSP/DAP ports;
- isolated `run_project` state.

`run_project`, `get_debug_output`, and `stop_project` are routed through that worktree's dedicated Godot MCP process.

## Godot MCP responsibilities

GWRM does not reimplement Godot MCP scene operations. The pinned `@coding-solo/godot-mcp` package remains responsible for:

- launching the visual editor;
- running a project/scene graphically;
- collecting debug output;
- stopping that graphical project process;
- scene/resource operations such as create scene, add node, load sprite, save scene, export MeshLibrary, and UID maintenance.

The scene/resource mutation operations are performed by the upstream MCP using short-lived `Godot --headless --script` executions. The visual editor and `run_project` remain graphical.

## GUT supervision

GUT calls are asynchronous at the GWRM MCP layer. `run_gut_tests` and `run_gut_test_script` create an in-memory operation and return an `operation_id`. `get_gut_run_status` reads that operation until `terminal=true`.

Identical queued/running test selections reuse the same operation ID to avoid duplicate test processes after client transport retries.

## Computer Use boundary

Computer Use is generic; it has no scene-specific knowledge.

GWRM does not know what a button such as "Start", "Add Actor", or "Save" means. It only exposes general primitives for:

- discovering authorized graphical Godot windows;
- semantic accessibility inspection;
- bounded internal waits;
- click, text, key, hotkey, and scroll actions;
- screenshot capture on explicit request.

Before exposing a window, GWRM resolves processes whose command line references the requested worktree. It keeps only Godot processes, excludes the persistent headless Godot process, and rejects a `window_id` that does not belong to the authorized process set.

## Observation policy

Computer Use is semantic-first:

1. discover windows;
2. inspect the accessibility tree without a screenshot;
3. address controls using `element_token` when possible;
4. use window-local pixel coordinates for custom-rendered surfaces;
5. capture a screenshot only when semantic state is insufficient.

Input uses background delivery by default. Foreground delivery is an explicit per-action escalation.

## Persistent state

Each registered worktree has a JSON record under the configured state directory. Desired-active worktrees are reconciled after GWRM restarts. Missing worktrees can be removed automatically according to configuration.

## Logging

The structured JSONL log keeps event fields, including worktree information. Console output includes the worktree column when available:

```text
[GWRM] 14:27:10 | t_example | INFO | Worktree ready.
```

Events without worktree context use `-`.
