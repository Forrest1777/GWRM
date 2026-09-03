# Computer Use

GWRM 1.1 adds optional Windows graphical automation through Cua Driver while preserving the existing single-process GWRM user experience.

## Requirements

- Windows 10/11 interactive desktop session.
- Cua Driver installed and available as `cua-driver` (or another configured command).
- A graphical Godot process associated with the target worktree. Normally it is created by GWRM's existing `run_project` or `launch_editor` tool.

Verify the host before relying on Computer Use:

```powershell
cua-driver --version
cua-driver doctor
cua-driver call list_windows
```

## Lifecycle

No separate Cua startup command is required by GWRM's default Windows integration.

```text
start-gwrm.bat
  -> launcher
  -> supervisor
  -> ComputerUseService
  -> cua-driver mcp
```

On GWRM shutdown, the MCP client closes and Cua Driver exits with its owned runtime.

## Configuration

The `computer_use` block is optional. Defaults are shown in `gwrm.config.example.json`.

```json
{
  "computer_use": {
    "enabled": true,
    "required": false,
    "command": "cua-driver",
    "args": ["mcp"],
    "protocol_version": "2024-11-05",
    "startup_timeout_seconds": 20,
    "request_timeout_seconds": 60,
    "permission_mode": "standard",
    "wait_timeout_seconds": 15,
    "max_wait_timeout_seconds": 60,
    "wait_poll_milliseconds": 500,
    "max_semantic_elements": 400,
    "max_semantic_depth": 16,
    "max_image_dimension": 900
  }
}
```

When `required` is false, GWRM remains usable for Godot/LSP/GUT if Cua Driver is missing. `gui_status` reports the reason Computer Use is unavailable.

## Bounded mode

For unattended environments, Cua Driver can be started in `bounded` permission mode. Configure an operator-reviewed capability manifest:

```json
{
  "computer_use": {
    "permission_mode": "bounded",
    "capability_manifest_file": "./cua-capabilities.yaml",
    "capability_manifest_approved": true
  }
}
```

GWRM sets the Cua Driver runtime environment at child-process startup. An invalid or unapproved bounded configuration fails closed.

## Tools

The GWRM MCP facade exposes:

- `gui_status`
- `gui_list_windows`
- `gui_wait_for_window`
- `gui_inspect_window`
- `gui_capture_window`
- `gui_wait_for_element`
- `gui_click`
- `gui_type_text`
- `gui_press_key`
- `gui_hotkey`
- `gui_scroll`

Every window operation requires a `worktree_name`. Every action against a window requires an authorized `window_id` returned for that worktree.

## Token-efficient usage

Prefer this loop:

```text
run_project
-> gui_wait_for_window
-> gui_inspect_window (no screenshot)
-> gui_click(element_token=...)
-> gui_inspect_window again to verify the state change
```

Use `gui_capture_window` only for custom-drawn controls, visual rendering checks, or debugging when the accessibility tree is insufficient.

`gui_inspect_window` passes `include_screenshot=false` to Cua Driver and limits semantic tree size. `gui_capture_window` explicitly requests an image and caps its long edge.

## Background-first input

All action tools default to `delivery_mode="background"`. This avoids unnecessary focus stealing. When a background action cannot be confirmed, retry only that action with `delivery_mode="foreground"` and inspect state again.

## No scene hardcoding

GWRM intentionally contains no AI ARENA, game-menu, HUD, editor-plugin, or scene-specific sequence. Scene-specific expectations belong to the agent, test specification, or external declarative workflow.
