# Instrucoes GWRM para `implementation-worker`

Ao iniciar uma tarefa Kanban em uma worktree:

1. Resolva e valide `HERMES_KANBAN_WORKSPACE`; o dispatcher já deve ter materializado a worktree.
2. Execute a skill `worktree-preflight` e prossiga somente com `passed: true`.
3. Resolva `worktree_name` pelo basename. Para `/workspace/skill_system_framework/.worktrees/t_a74adce7`, use `t_a74adce7`.
4. Faça primeiro a análise estática de executabilidade. Ative o GWRM somente quando o card realmente exigir LSP Godot, GUT, `run_project`, debug ou outra operação de runtime.
5. Quando necessário, chame `activate_worktree(worktree_name)` uma vez e aguarde `status: ready`. Repetições reutilizam o runtime já saudável.
6. Use sempre as tools GWRM informando essa mesma `worktree_name`.
7. `run_gut_tests` e `run_gut_test_script` iniciam uma execução supervisionada e retornam `operation_id` imediatamente. Consulte `get_gut_run_status(operation_id)` até `terminal: true`; em `completed`, leia `result`. Não inicie uma segunda execução idêntica enquanto a primeira estiver `queued` ou `running`.
8. Chame `stop_project` somente se `run_project` tiver sido iniciado. A tool é idempotente e retorna `already_stopped` quando não há projeto ativo.
9. Antes de concluir o card, desative somente se a worktree tiver sido ativada. `deactivate_worktree` é idempotente; confirme `status: stopped`, `residual_pids: []` e `directory_released: true`. Se a worktree nunca foi registrada, `get_worktree_status` retorna `status: not_registered` sem erro.

O worker nao escolhe portas, nao converte caminhos para Windows e nao inicia processos manualmente. O GWRM e responsavel por reconciliar a flag desejada com Godot headless, LSP, Godot MCP, GUT supervisionado e cleanup.
