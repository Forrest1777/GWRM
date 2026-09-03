# GWRM instructions for implementation-worker

When starting a Kanban task in a worktree:

1. Resolve and validate `HERMES_KANBAN_WORKSPACE`; the dispatcher must already have materialized the worktree.
2. Run the `worktree-preflight` skill and proceed only when `passed: true`.
3. Resolve `worktree_name` from the workspace basename.
4. Perform static executability analysis first. Activate GWRM only when the task needs Godot LSP, GUT, `run_project`, debug, scene/resource tools, or graphical interaction.
5. When required, call `activate_worktree(worktree_name)` once and wait for `status: ready`. Repeated calls reuse a healthy runtime.
6. Always pass the same `worktree_name` to GWRM tools.
7. `run_gut_tests` and `run_gut_test_script` return an `operation_id`. Query `get_gut_run_status(operation_id)` until `terminal: true`. Do not start an identical second run while the first is queued/running.
8. If `run_project` starts a graphical scene, use `gui_wait_for_window` then `gui_inspect_window`. Prefer semantic element tokens; use `gui_capture_window` only when needed.
9. Use background GUI delivery first. Escalate only the failing action to `foreground` when required and re-inspect state afterward.
10. Call `stop_project` only if `run_project` was started.
11. Before completing the task, deactivate only if the worktree was activated. Confirm `status: stopped`, `residual_pids: []`, and `directory_released: true`.

The worker does not choose ports, translate paths manually, or start unmanaged Godot/Cua processes. GWRM owns the Windows runtime boundary.
