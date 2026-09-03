# Validation

## Static JavaScript validation

```powershell
npm run check
```

## Unit/integration tests

```powershell
npm test
```

The repository tests use fake Godot, fake Godot MCP, and fake Cua MCP processes where possible so core lifecycle and routing can be tested without modifying a real project.

## Windows host validation

After configuring a real host, verify in this order:

1. `start-gwrm.bat` reaches `GWRM READY`.
2. Hermes can call `gwrm_status`.
3. Activate a disposable worktree and confirm `status=ready`.
4. Confirm LSP resolves to that worktree.
5. Run a small GUT selection and collect its terminal operation result.
6. Run a graphical Godot scene using `run_project`.
7. Call `gui_wait_for_window` for that worktree.
8. Call `gui_inspect_window` without a screenshot.
9. Exercise one safe semantic action in background mode and re-inspect.
10. Capture an image only if visual evidence is required.
11. `stop_project`, then deactivate the worktree.
12. Confirm no residual Godot process references that worktree path.
13. Stop GWRM with `CTRL+C` and confirm its child services exit.

Real graphical Cua/Godot behavior depends on the interactive Windows session and must be validated on the target host; the source package cannot certify that environment by unit tests alone.
