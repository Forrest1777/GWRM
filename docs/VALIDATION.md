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

## TODO11 gate F — concurrent Godot AI isolation (live)

Live proof on Windows host (Godot 4.7.2 + Godot AI 4.0.4), card TODO11-11 successor of superseded t_c6fbc01c, head containing EditorSettings 4.7 path fix.

Harness: `tests/godot-ai-concurrent-live.test.mjs` (skipped unless `GWRM_GODOT_AI_LIVE=1` on win32).

Isolated run (not production GWRM / not production state):

```text
mode: in_process SessionManager from this worktree src
isolated_root: .../.hermes-tmp/todo11-gatef-gwrm-gatef-gVXbxR
worktrees: gatef_a, gatef_b (disposable copies with addons/godot_ai 4.0.4)
```

Observed while both active:

```text
gatef_a:
  status=ready
  godot_ai.status=session_ready
  session_id=gatef-a@dd4de20d16a7e0ec
  http_port=18200 ws_port=19700
  gui_pid=114156

gatef_b:
  status=ready
  godot_ai.status=session_ready
  session_id=gatef-b@53eedd9663025bf1
  http_port=18201 ws_port=19701
  gui_pid=147028
```

Explicit callTool identity (operation `session_manage` op=list with each worktree session_id):

- A identity project_path ends with `/worktrees/gatef_a/`
- B identity project_path ends with `/worktrees/gatef_b/`
- foreign session_id on the other attach did not return the other worktree identity

Teardown:

```text
gatef_a/b: status=stopped, godot_ai.status=runtime_stopped, residual_pids=[], directory_released=true
editor_settings-4.7.tres restored from backup
production mcp/control ports 8123/8130 unused by this proof
```

Harness notes (not src changes):

- Godot 4.7.2 graphical launch yields console+GUI process pair; live lister prefers non-console GUI pid
- short settle after HTTP listen before attach so session_manage list is populated
- `npm test` without `GWRM_GODOT_AI_LIVE` skips this file

## Remaining environment-specific validation

The packaging environment itself does not execute the native Windows stack. Revalidate on the target host after upgrading whenever any of these dependencies change materially:

- Windows version / desktop session model;
- Godot version;
- Cua Driver version;
- Docker Desktop networking;
- Hermes MCP behavior.
<!-- HERMES_TODO6_OPS_C_E2E_2026_09_14:BEGIN -->
## OPS-C final E2E hardening - 2026-09-14

Gate consolidado executado no host Windows depois de TODO5 / Godot AI 4.1.0.

Evidencias compostas e live:

- TODO5 Gate F preservado como checkpoint: duas worktrees reais, sessoes Godot AI distintas, sem cross-talk e teardown validado.
- TODO5 GUT headless preservado como checkpoint: suite ai_system verde.
- duas novas worktrees descartaveis OPS-C foram mantidas ativas simultaneamente com o addon Godot AI 4.1.0 sincronizado do projeto canonico;
- cada worktree atingiu runtime ready, Godot MCP ready, LSP ready e Godot AI session_ready;
- session_id, HTTP, WS, GUI PID e LSP relay permaneceram distintos entre as worktrees;
- AI ARENA iniciou e encerrou via GWRM em ambas sem erro fatal de carregamento;
- restart real do GWRM preservou desired_active e o startup reconcile reconvergiu ambas as worktrees para session_ready;
- pares HTTP/WS permaneceram sticky atraves do restart;
- traversal/invalid worktree foi recusado fail-closed;
- teardown final exigiu status=stopped, godot_ai.status=runtime_stopped, residual_pids=[] e directory_released=true antes de remover as worktrees;
- Hermes event-driven GUT bridge, thin orchestrator e operational-cost-telemetry foram validados live, sem polling GUT no runner ativo;
- nenhum core Hermes foi modificado e nenhum push foi executado pelo gate.

OPS-C valida operacao integrada e lifecycle; nao altera a logica de gameplay/autonomia do AI ARENA.
<!-- HERMES_TODO6_OPS_C_E2E_2026_09_14:END -->
