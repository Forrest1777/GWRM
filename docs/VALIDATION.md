# Validation

## Static validation

Run:

```powershell
npm run check
npm test
```

The source package validates JavaScript syntax, JSON templates, Python integration modules, the Bash worktree preflight, worktree isolation, Godot/GUT routing, MCP facade policy, Computer Use routing, Cua lifecycle recovery, and startup timeout policy.

Latest package validation result:

```text
Node tests: 19 passed, 0 failed
JavaScript syntax: PASS
JSON templates: PASS
Python integration modules: PASS
Bash worktree preflight: PASS
```

## Cua lifecycle regression coverage

The Computer Use test suite now verifies that:

- `start_session` and `end_session` are required Cua tools;
- GWRM resets the implicit Cua lifecycle during Computer Use startup;
- an expired Cua session is revived before GUI reads;
- an expired Cua session is revived before mutating actions;
- mutating actions such as `click` are not automatically retried;
- GWRM requests `end_session` during shutdown before closing the MCP transport.

This covers the Windows failure observed when Cua returned:

```text
this session has ended; call start_session explicitly to reuse its label
```

## Startup reconciliation regression coverage

Launcher readiness no longer uses a fixed 30-second supervisor budget.

The startup timeout policy now:

- has a 60-second minimum;
- grows according to the number of persisted worktree state files and the configured shutdown budget;
- is capped at 10 minutes so a genuinely stuck supervisor still fails finitely.

This allows startup reconciliation to close stale worktree runtimes without causing a false launcher timeout.

## Real Windows host smoke validation — 2026-09-03

A real end-to-end smoke was completed on an interactive Windows desktop using a disposable Hermes worktree and the existing Godot scene:

`res://addons/gut/gui/ShortcutButton.tscn`

Validated path:

```text
Hermes worker
  -> GWRM MCP facade
  -> isolated worktree activation
  -> graphical Godot run_project
  -> GWRM Computer Use service
  -> Windows Cua Driver
  -> authorized Godot window discovery
  -> visual fallback capture
  -> background click on Set
  -> visible transition to Save / Cancel
  -> stop_project
  -> worktree deactivation and cleanup
```

Observed result:

- worktree preflight passed;
- GWRM activation reached `ready`;
- graphical Godot window opened on Windows;
- authorized window discovery succeeded;
- semantic-first inspection was attempted;
- visual fallback was used when the Godot controls were not sufficiently exposed semantically;
- the `Set` button was clicked through GWRM/Cua in background delivery mode;
- the post-click `Save` / `Cancel` state was visually verified;
- `stop_project` passed;
- deactivation completed with zero residual PIDs and the directory released;
- Git remained clean;
- no code change, commit, or push occurred inside the smoke worktree.

No Cua lifecycle error reappeared after the lifecycle fix.

## Remaining environment-specific validation

The packaging environment itself does not execute the native Windows stack. Revalidate on the target host after upgrading whenever any of these dependencies change materially:

- Windows version / desktop session model;
- Godot version;
- Cua Driver version;
- Docker Desktop networking;
- Hermes MCP behavior.
