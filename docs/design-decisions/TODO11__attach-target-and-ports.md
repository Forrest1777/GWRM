# TODO11 — Alvo de attach Godot AI e portas por worktree

- **Phase:** TODO11
- **Source cards:** `t_dcb7e641`
- **Affected cards:** nenhum card de implementacao adicional neste persist (root `t_dcb7e641` consome apos integracao)
- **Architecture card:** `t_3f6ba1b1`
- **Date:** 2026-09-11T16:48:17Z
- **Review kind:** `DESIGN_DECISION_REQUIRED`
- **Status:** aprovado / persistido neste worktree; integracao pelo orquestrador
- **Approved bundle:** `TODO11-P1`
- **User decision:** dashboard no card `t_3f6ba1b1`: `D1=A D2=A D3=A D4=A` + dois adendos
- **Decision commit:** pending (preenchido apos persist)

## Problem

TODO11 exige que `activate_worktree` / `deactivate_worktree` convirjam uma sessao Godot AI isolada por worktree, com `session_id` explicito e prova concorrente de duas worktrees. O spike GODOT-AI-SPIKE-01 comprovou attach apenas contra editor GUI via `launch_editor`. O runtime persistente TODO9 e `--headless --editor` e nao entra na lista Godot AI. O plugin 4.0.4 usa HTTP 8000 / WS 9500 em EditorSettings globais e nao faz fallback HTTP se a porta estiver ocupada.

## Evidence and constraints

- Card `t_3f6ba1b1` criado pelo `implementation-orchestrator` apos gap concreto; `goal_mode=false`; `gwrm_required=false`.
- Freeze TODO11: GWRM permanece Runtime Governor; nao redesenhar desired/observed TODO9; nao remover MCP/LSP/Computer Use; nao fallback silencioso CU/MCP nos gates Godot AI; pin 4.7.2 / 4.0.4; sem `session_activate` como routing normal; sem sessao global implicita; `push_performed=false`.
- Spike: headless nao listado mesmo com `GODOT_AI_ALLOW_HEADLESS=1`; bootstrap = activate ready, `launch_editor`, plugin connected, `godot-ai attach --port/--ws-port`; duas GUIs no mesmo projeto = duas sessoes.
- `src/session-manager.mjs` spawna `--headless --editor` e aloca LSP/DAP via `allocatePort` + reserved set (`src/ports.mjs`). Faixas atuais: LSP 6100-6199, DAP 6200-6299, proxy 7100-7199, MCP 8123, control 8130.
- `launch_editor` / `run_project` ja pertencem ao Godot MCP dedicado (`docs/ARCHITECTURE.md`, addendum 1.1.0). Computer Use so aceita Godot grafico cujo command line referencia o path da worktree e exclui `--headless`.
- Plugin 4.0.4: HTTP/WS em EditorSettings, nao env; HTTP ocupada falha.
- Gate 1 publicou `recommended_bundle` `TODO11-P1` no proprio card e bloqueou `AWAITING_ARCHITECTURE_APPROVAL bundle=TODO11-P1`.
- Aprovacao humana no card (dashboard): D1=A D2=A D3=A D4=A.
  1. `runtime.status` e `godot_ai.status` independentes; falha Godot AI nao transforma runtime TODO9 saudavel em `failed`.
  2. escrita EditorSettings + launch/reuse + wait listen + attach e secao critica global; reconcile/relaunch reaplica as portas registradas antes de iniciar a GUI de novo.
- `worktree_guardian_verify`: passed; `wt/t_3f6ba1b1` @ `e4fd0148e8d4b3d8c123c984bca9399ba0b6897f`; linked; sem sparse/`index.lock`; tracked 67.
- Arquivos autorizados somente: `docs/GODOT_AI.md`, `docs/design-decisions/TODO11__attach-target-and-ports.md`.
- `AGENTS.md` ausente neste repositorio GWRM.

## Options considered

Material alternatives closed in Gate 1 and approved:

| ID | Approved | Rejected |
|---|---|---|
| D1 attach_target | A — `GUI_EDITOR_VIA_LAUNCH_EDITOR` | B headless persistente (nao comprovado); C trocar TODO9 por um unico GUI (redesenha TODO9) |
| D2 session_establish_timing | A — `POST_TODO9_RUNTIME_IN_ACTIVATE` | B bloquear ready TODO9 no Godot AI; C attach lazy na primeira chamada |
| D3 port_assignment | A — `GWRM_ALLOCATE_UNIQUE_HTTP_WS` | B defaults 8000/9500; C observar portas apos bind do plugin |
| D4 gui_process_policy | A — `ACTIVATE_REUSES_OR_LAUNCH_EDITOR_TRACKED_PID` | B activate nao abre GUI; C spawn grafico proprio do GWRM |

Adendos aprovados nao reabrem D1-D4: tornam independentes os dois `status` e tornam a secao critica/reaplicacao de portas normativa.

## User decision

`aprove D1=A D2=A D3=A D4=A` no card `t_3f6ba1b1`, bundle `TODO11-P1`, com os dois adendos acima. Nao houve silencio interpretado como aprovacao.

## Consolidated contract

Autoridade: `docs/GODOT_AI.md`. Resumo:

- Attach so na GUI da worktree via `launch_editor`. Headless TODO9, `run_project` e GUT nao sao alvos.
- Apos `#ensureRunning` TODO9, ainda em `activate_worktree`, garantir GUI, attach e registrar `session_id` observado.
- Falha Godot AI nao derruba `desired_active` nem `status` TODO9.
- `deactivate` libera a sessao e so entao `stopRuntime` TODO9.
- Reconcile revalida observacao; persistido e cache invalidavel; nao duplica headless.
- GWRM aloca HTTP/WS unicos; faixas planejadas 18000-18099 / 19500-19599 (100+100, disjuntas das faixas TODO9 e de 8000-8099). Verificacao aritmetica: `http_count=100`, `ws_count=100`, overlaps com LSP/DAP/proxy/8000-8099/entre si = 0.
- Secao critica global: EditorSettings -> launch/reuse -> listen `127.0.0.1:<http>` -> attach. Reconcile reaplica o par registrado antes de relancar a GUI.
- Uma GUI por worktree ativa; reuse obrigatorio; `gui_pid` observado, nao e segundo desired runtime.
- `get_worktree_status.godot_ai.status`: `runtime_stopped` | `runtime_no_session` | `session_ready` | `session_invalid` | `integration_error`.
- MCP/LSP/Computer Use permanecem; gates Godot AI nao fazem fallback silencioso.

## Files updated

- `docs/GODOT_AI.md`
- `docs/design-decisions/TODO11__attach-target-and-ports.md`

Nao atualizados (proibidos neste card): `src/**`, `tests/**`, `gwrm.config.example.json`, `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE_ADDENDUM_1.1.0.md`, profiles/skills, roadmap.

## Implementation consequences

1. Orquestrador integra este commit em `todo11/t_dcb7e641` antes de retomar workers de lifecycle/status.
2. Orquestrador atualiza `architecture_revision` e sincroniza worktrees.
3. `GodotAiBridge` continua dono so do protocolo; nao escolhe alvo/portas.
4. `GodotAiSessionRegistry` e dono da associacao; `session_id` persistido nao e utilizavel ate revalidar.
5. `SessionManager` sequencia a convergencia Godot AI depois do ready TODO9, sem redefinir `status` TODO9.
6. `get_worktree_status` ganha objeto `godot_ai` sem reusar o campo `status` do runtime.
7. Config de faixas HTTP/WS e wiring real ficam para cards posteriores; este persist nao muta runtime.
8. Nao iniciar TODO12 a partir deste persist.

## Remaining open points

- Chaves concretas dos EditorSettings do plugin 4.0.4 no Godot 4.7.2 (descoberta de implementacao).
- Chaves `gwrm.config` / exemplo de faixas HTTP/WS (fora dos arquivos autorizados).
- Wiring SessionManager <-> Bridge <-> Registry; exposicao em `get_worktree_status`.
- Teste concorrente ao vivo de duas worktrees (gate F do root).
- Atualizacao diagramatica de `docs/ARCHITECTURE.md` (arquivo read-only neste card).
- Cutover TODO12.

## Validation

- `git diff --check`: passed (cached, apenas os dois arquivos autorizados).
- Spec review: passed (ver handoff).
- Standards review: passed (ver handoff).
- GWRM: nao usado (`gwrm_required=false`).
- Runtime/testes: nao alterados.
