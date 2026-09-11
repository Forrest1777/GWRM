# Godot AI no GWRM (TODO11)

Este documento e a autoridade canonica do alvo de attach, do timing da sessao, das portas HTTP/WS por worktree e da politica do processo GUI. O lifecycle `desired_active` / `status` do runtime persistente permanece em `docs/ARCHITECTURE.md` e no addendum 1.1.0. Este contrato e aditivo: nao substitui headless, LSP, Godot MCP nem Computer Use.

Pins: Godot 4.7.2 e Godot AI 4.0.4. Nao assumir capacidade ausente do spike GODOT-AI-SPIKE-01.

```text
Hermes
  -> GWRM Runtime Governor
       |- TODO9: --headless --editor + LSP/DAP + Godot MCP
       |- GUI editor via Godot MCP launch_editor   (alvo de attach)
       |- GodotAiBridge  (attach / call com session_id explicito)
       `- GodotAiSessionRegistry  (worktree -> GUI/runtime -> session_id)
```

## 1. Alvo de attach

O `GodotAiBridge` anexa somente ao editor grafico da worktree obtido por `launch_editor` do Godot MCP dedicado.

Nao sao alvos de attach:

- o Godot persistente `--headless --editor` (`godot_pid` do TODO9);
- o processo de `run_project`;
- processos GUT headless.

Evidencia do spike: o editor headless do GWRM nao entra na lista Godot AI, inclusive com `GODOT_AI_ALLOW_HEADLESS=1`. Attach comprovado: `activate_worktree` ready, depois `launch_editor`, plugin server connected, depois `godot-ai attach --port <http> --ws-port <ws>`.

O runtime persistente TODO9 continua existindo para importacao, LSP, DAP e Godot MCP. A GUI e um processo adicional governado, nao um segundo desired runtime.

## 2. Timing da sessao

Sequencia normativa de `activate_worktree` (ainda dentro da mesma chamada, apos `#ensureRunning` TODO9):

1. Convergir o runtime persistente (headless + LSP + MCP). `status` TODO9 so reflete esse runtime.
2. Garantir par HTTP/WS exclusivo da worktree (secao 3).
3. Entrar na secao critica global (secao 3) para garantir a GUI, esperar o plugin listening e fazer attach.
4. Registrar o `session_id` observado no `GodotAiSessionRegistry`.

Falha da integracao Godot AI nao altera `desired_active` e nao transforma um runtime TODO9 saudavel em `failed`. Nao para o headless. Se o attach nao obteve sessao utilizavel, `godot_ai.status` e `integration_error`. Se um `session_id` ja observado deixou de ser confiavel, `godot_ai.status` e `session_invalid`. `activate_worktree` pode devolver `status=ready` com `godot_ai.status != session_ready`.

`runtime.status` (campo publico `status` de `get_worktree_status`) e `godot_ai.status` sao independentes.

Sequencia normativa de `deactivate_worktree`:

1. Operacoes Godot AI pendentes terminam ou falham de forma deterministica.
2. Liberar/desassociar a sessao no registry; a associacao deixa de ser utilizavel.
3. So entao `#stopRuntime` TODO9 (relay, arvore do Godot MCP, Godot residual do path da worktree).

Reconciliacao:

- revalidar o `session_id` observado; nao tratar o valor persistido como utilizavel;
- persistencia de `session_id` e no maximo cache invalidavel (`session_invalid` ate prova observada);
- nao duplicar o headless TODO9 por causa da reconvergencia Godot AI;
- se `desired_active` e a GUI saudavel sumiu: um `launch_editor`, nunca spawn grafico proprio do GWRM;
- relancar a GUI so depois de reaplicar o par HTTP/WS ja registrado daquela worktree.

Attach preguicoso na primeira chamada Godot AI nao satisfaz o lifecycle do TODO11.

## 3. Portas HTTP/WS

O GWRM aloca um par HTTP/WS exclusivo por worktree com o mesmo padrao de `allocatePort` + conjunto reservado ja usado para LSP/DAP. O attach usa exatamente esse par (`--port` / `--ws-port`). Duas worktrees ativas nao compartilham o par.

Faixas em `gwrm.config.example.json` e `gwrm.config_DEFAULT.json` (`godot_ai_http_start`/`godot_ai_http_end`, `godot_ai_ws_start`/`godot_ai_ws_end`):

- HTTP: 18000-18099 (100 portas);
- WS: 19500-19599 (100 portas).

As faixas sao disjuntas entre si e das ja congeladas: LSP 6100-6199, DAP 6200-6299, proxy 7100-7199, MCP 8123, controle 8130. Evitar 8000-8099 (exclusao Hyper-V/WSL documentada no plugin 4.0.4). Nao usar os defaults do plugin (HTTP 8000 / WS 9500) como contrato de isolamento concorrente.

O plugin 4.0.4 le HTTP/WS de EditorSettings do usuario Windows, nao de env. Porta HTTP ocupada ou reservada falha; WS so desvia se o Windows excluiu a faixa. Nao patchar `addons/godot_ai`.

### Secao critica global

A escrita dos EditorSettings HTTP/WS + launch/reuse da GUI + espera de listen + attach e uma secao critica global do GWRM, serializada entre worktrees:

1. gravar o par HTTP/WS registrado da worktree nos EditorSettings;
2. `launch_editor` ou reuse da GUI saudavel;
3. esperar listen em `127.0.0.1:<http_port>`;
4. attach com esse mesmo par.

Nao mutar EditorSettings de novo ate o server daquela GUI estar listening. Dois `activate_worktree` concorrentes serializam somente essa secao; o headless TODO9 pode subir em paralelo.

Reconcile/relaunch reaplica as portas registradas daquela worktree antes de iniciar novamente a GUI. Descobrir portas apos o bind do plugin nao e contrato: o plugin nao faz fallback HTTP se 8000 estiver ocupada.

## 4. Politica do processo GUI

`activate_worktree` pode iniciar GUI somente via `launch_editor` do Godot MCP dedicado. O GWRM nao cria launcher grafico proprio.

Reuse e obrigatorio quando existir GUI saudavel da worktree:

- command line referencia `host_project_path`;
- command line nao contem `--headless`;
- PID diferente de `godot_pid` persistente;
- PID diferente do processo de `run_project`.

Proibido segundo `launch_editor` se essa GUI saudavel existir. Uma worktree ativa tem no maximo uma GUI alvo de attach. `launch_editor` duplicado no mesmo projeto produz sessoes Godot AI distintas e cross-talk (comprovado no spike).

O PID da GUI (`gui_pid`) e observado no registro Godot AI. Nao e um segundo `desired` runtime TODO9. Computer Use continua podendo usar essa janela pela politica worktree-bound ja canonica. `run_project` permanece owner da execucao grafica de cenas e nao e alvo de attach.

## 5. Registry, routing e status

Owner da associacao `worktree -> GUI/runtime -> session_id`: `GodotAiSessionRegistry`. Owner do protocolo Godot AI: `GodotAiBridge`. Owner do desired/observed TODO9: `SessionManager`. Owner de `launch_editor` / `run_project`: Godot MCP dedicado.

Toda operacao Godot AI identifica `session_id` explicito. Proibido:

- ultima sessao usada, sessao global, ordem de chamadas;
- `session_activate` como routing normal;
- fallback silencioso para outra sessao;
- fallback silencioso para Computer Use ou Godot MCP nos gates Godot AI.

Sessao invalida/desconectada gera erro explicito ou reconcilia a previsao deste contrato.

`get_worktree_status` mantem o campo `status` como runtime TODO9 e acrescenta o objeto `godot_ai`. Nao expor segredos, tokens nem credenciais.

Valores de `godot_ai.status`:

| Valor | Significado |
|---|---|
| `runtime_stopped` | runtime Godot persistente ausente / nao iniciado / parado |
| `runtime_no_session` | runtime TODO9 presente, sem sessao Godot AI utilizavel |
| `session_ready` | sessao observada, conectada e utilizavel |
| `session_invalid` | `session_id` conhecido mas nao confiavel (sumiu, restore, desconectou) |
| `integration_error` | falha de attach, plugin, porta ou EditorSettings |

Campos publicos minimos de `godot_ai`:

- `status` (enum acima);
- `session_id` (`string` ou `null`; diagnostico; routing so consome se `status=session_ready`);
- `http_port` / `ws_port` (`integer` ou `null`);
- `gui_pid` (`integer` ou `null`);
- `last_error` (`{code, message}` ou `null`).

### Exemplos (campos omitidos sao os ja existentes do TODO9)

Runtime TODO9 pronto, Godot AI ainda nao anexado:

```text
status: ready
desired_active: true
godot_ai.status: runtime_no_session
godot_ai.session_id: null
godot_ai.gui_pid: null
```

Sessao pronta (par ilustrativo da faixa planejada):

```text
status: ready
desired_active: true
godot_ai.status: session_ready
godot_ai.session_id: "sess_a"
godot_ai.http_port: 18001
godot_ai.ws_port: 19501
godot_ai.gui_pid: 4321
godot_ai.last_error: null
```

Falha Godot AI com runtime TODO9 saudavel:

```text
status: ready
desired_active: true
godot_ai.status: integration_error
godot_ai.session_id: null
```

Worktree parada:

```text
status: stopped
desired_active: false
godot_ai.status: runtime_stopped
godot_ai.session_id: null
godot_ai.gui_pid: null
```

## 6. Compatibilidade e limites 4.0.4

Durante TODO11 permanecem disponiveis Godot MCP, LSP e Computer Use. Sua existencia nao autoriza usa-los como implementacao primaria dos gates Godot AI. Cutover destrutivo e TODO12.

Limites conhecidos e congelados por este contrato:

- attach headless nao qualificado;
- EditorSettings globais (por isso a secao critica);
- plugin sem fallback HTTP se a porta default estiver ocupada;
- duas GUIs no mesmo projeto => duas sessoes e risco de cross-talk.
