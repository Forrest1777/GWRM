---
name: godot-development
description: Develop and validate Godot/GDScript worktrees using GWRM, LSP, Godot MCP, GUT, and optional graphical Computer Use.
---

# Godot/GDScript with GWRM

## Lifecycle

1. Validate the dispatcher-provisioned worktree with `worktree-preflight`.
2. Resolve `worktree_name` from the basename of `HERMES_KANBAN_WORKSPACE`.
3. Perform static analysis first. Activate GWRM only when runtime/LSP/GUT/Godot MCP/GUI access is needed.
4. Use the same `worktree_name` for all Godot, GUT, and GUI tools.
5. Stop a project if `run_project` was used.
6. Deactivate the worktree before completing the task and confirm `status: stopped`, `residual_pids: []`, and `directory_released: true`.

The worker does not choose ports, launch unmanaged Godot processes, or manually translate Windows/container paths.

## Paths

- Use `res://` for project resources.
- Use `user://` for writable runtime data.
- Never commit host-specific absolute Windows/Linux paths into code, scenes, or resources.
- Absolute host paths belong only in local GWRM configuration.

## Validation

- LSP: syntax, types, symbols, references, semantic diagnostics.
- Dedicated Godot MCP: scene/resource operations, graphical project execution, debug output.
- GUT: behavior and integration validation.
- Computer Use: real graphical interaction when a human-like UI gate is needed.
- GWRM: lifecycle, imports, ports, process ownership, mapping, and cleanup.

Prefer semantic GUI inspection and element tokens. Request screenshots only when the accessibility tree is insufficient or visual evidence is explicitly required.
