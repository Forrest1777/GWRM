# Worktree and Cleanup Fixes — Historical Note

The current runtime preserves the following worktree integrity behavior introduced by earlier fixes:

- persisted worktree paths are migrated when configured roots change;
- Hermes integration includes a mandatory worktree preflight;
- Godot MCP clients and log streams are awaited during shutdown;
- known process trees are terminated before a worktree is reported as stopped;
- Windows cleanup searches for residual Godot processes whose command line still references the worktree path;
- status exposes `residual_pids` and `directory_released`;
- `status: stopped` is published only after manageable residual Godot processes are gone;
- the Windows PowerShell process probe keeps the complete `Where-Object` predicate in one statement, preventing invalid `-and;` / `-or;` token sequences.

`directory_released: true` confirms the GWRM-managed process boundary is clear. External software such as antivirus, Explorer, editors, or unrelated tools may still hold filesystem handles and must be diagnosed on the host if deletion fails.
