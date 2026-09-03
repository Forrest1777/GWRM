# Arquitetura do GWRM

```text
Hermes no Docker
  ├─ MCP estavel: host.docker.internal:8123/mcp
  └─ plugin LSP dinamico
       └─ API de controle: host.docker.internal:8130

GWRM no Windows
  ├─ registro persistente por worktree
  ├─ reconciliador de estado desejado/real
  ├─ supervisor singleton independente das sessoes HTTP MCP
  ├─ facade MCP leve criado pelo mcp-proxy
  ├─ uma instancia Godot headless persistente por worktree ativa
  │    ├─ --headless --editor --path <WORKTREE>
  │    ├─ porta LSP interna exclusiva e relay TCP externo exclusivo
  │    ├─ porta DAP exclusiva para evitar conflito
  │    └─ cache .godot e class_name da propria worktree
  ├─ um Godot MCP stdio dedicado por worktree ativa
  ├─ processos GUT pontuais no projeto da worktree
  ├─ ComputerUseService singleton
  │    └─ cua-driver mcp (stdio, lifecycle pertencente ao GWRM)
  └─ cleanup quando active=false, a worktree desaparece ou o GWRM encerra
```

## Estado desejado

O worker altera somente `desired_active` pelas tools `activate_worktree` e `deactivate_worktree`. O GWRM executa imediatamente a reconciliacao. A rotina periodica corrige crashes, processos ausentes e worktrees removidas.

## Persistencia

Cada worktree possui `state/<worktree_name>.json`. Worktrees ativas sao restauradas quando o GWRM inicia. Quando o diretorio da worktree deixa de existir, seus processos e seu registro sao removidos.

## Isolamento

Cada Godot MCP e um subprocesso stdio independente, portanto seu `activeProcess` pertence somente a uma worktree. `run_project`, `get_debug_output` e `stop_project` nao compartilham estado entre agentes.

## Integridade e cleanup

O dispatcher do Hermes materializa a worktree. O worker deve executar `worktree-preflight` antes de ativar o GWRM. Na desativacao, o GWRM encerra relay, projeto, arvore do Godot MCP e Godot headless, procura processos Godot residuais que ainda referenciem o path, aguarda streams e so entao publica `status: stopped`, `residual_pids: []` e `directory_released: true`. Registros persistentes tem seus paths atualizados quando a raiz configurada muda.

No shutdown global, o supervisor tambem encerra o `ComputerUseService`; o `cua-driver mcp` pertence ao lifecycle do mesmo GWRM iniciado por `start-gwrm.bat`.

## GUT supervisionado

`run_gut_tests` e `run_gut_test_script` nao mantem uma chamada MCP aberta durante toda a execucao. O supervisor registra uma operacao em memoria, inicia o processo GUT sob o semaforo configurado e retorna `operation_id` imediatamente. O cliente consulta `get_gut_run_status` ate `terminal: true`. Chamadas identicas enquanto uma operacao estiver `queued` ou `running` reutilizam o mesmo `operation_id`, evitando execucoes duplicadas apos retry ou timeout de transporte.

## Idempotencia de lifecycle

`activate_worktree` reutiliza o runtime saudavel existente; `deactivate_worktree` retorna imediatamente quando a worktree ja esta totalmente parada; `get_worktree_status` representa worktrees desconhecidas como `not_registered` em vez de erro; e `stop_project` nao ativa uma worktree para para-la e nao encaminha `stop_project` ao Godot MCP quando nenhum `run_project` foi iniciado pelo runtime dedicado.

## Computer Use

O GWRM nao abre uma segunda instancia grafica para testes. `run_project` e `launch_editor` continuam pertencendo ao Godot MCP dedicado da worktree. O ComputerUseService apenas descobre e interage com as janelas resultantes.

O acesso GUI e worktree-bound. Para cada chamada, o GWRM localiza processos cuja command line referencia o path Windows da worktree, aceita apenas processos Godot graficos, exclui o Godot persistente `--headless` e cruza os PIDs autorizados com as janelas reportadas pelo Cua Driver. Um `window_id` fora desse conjunto e recusado.

A politica de percepcao e semantic-first:

- `gui_inspect_window`: arvore de acessibilidade, screenshot desabilitado por padrao;
- `gui_wait_for_window` e `gui_wait_for_element`: espera interna no GWRM, sem polling do agente;
- `gui_capture_window`: imagem apenas sob demanda;
- acoes: `delivery_mode=background` por padrao; `foreground` e escalacao explicita.

Nao existe logica especifica de cena no GWRM. AI ARENA ou qualquer outra cena e descrita pelo card/teste/agente usando as mesmas primitivas genericas.
