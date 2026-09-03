# Instrucoes GWRM para `implementation-worker`

Ao iniciar uma tarefa Kanban em uma worktree:

1. Resolva e valide `HERMES_KANBAN_WORKSPACE`; o dispatcher ja deve ter materializado a worktree.
2. Execute a skill `worktree-preflight` e prossiga somente com `passed: true`.
3. Resolva `worktree_name` pelo basename. Para `/workspace/skill_system_framework/.worktrees/t_a74adce7`, use `t_a74adce7`.
4. Faca primeiro a analise estatica de executabilidade. Ative o GWRM somente quando o card realmente exigir LSP Godot, GUT, `run_project`, debug ou outra operacao de runtime.
5. Quando necessario, chame `activate_worktree(worktree_name)` uma vez e aguarde `status: ready`. Repeticoes reutilizam o runtime ja saudavel.
6. Use sempre as tools GWRM informando essa mesma `worktree_name`.
7. `run_gut_tests` e `run_gut_test_script` iniciam uma execucao supervisionada e retornam `operation_id` imediatamente. Consulte `get_gut_run_status(operation_id)` ate `terminal: true`; em `completed`, leia `result`. Nao inicie uma segunda execucao identica enquanto a primeira estiver `queued` ou `running`.
8. Para validacao grafica, use `run_project`/`launch_editor` para criar a janela e depois as tools `gui_*`; o GWRM so autoriza janelas Godot pertencentes a processos associados a mesma worktree.
9. Em GUI, use `gui_wait_for_window` e `gui_wait_for_element` em vez de loops de polling no agente.
10. Percepcao GUI deve ser semantic-first: use `gui_inspect_window` com `query` quando possivel, prefira `element_token`, mantenha `delivery_mode=background` e use `gui_capture_window` somente quando a arvore semantica nao for suficiente.
11. Escale uma acao isolada para `delivery_mode=foreground` somente depois de uma tentativa background nao produzir o efeito esperado.
12. Chame `stop_project` somente se `run_project` tiver sido iniciado. A tool e idempotente e retorna `already_stopped` quando nao ha projeto ativo.
13. Antes de concluir o card, desative somente se a worktree tiver sido ativada. `deactivate_worktree` e idempotente; confirme `status: stopped`, `residual_pids: []` e `directory_released: true`. Se a worktree nunca foi registrada, `get_worktree_status` retorna `status: not_registered` sem erro.

O worker nao escolhe portas, nao converte caminhos para Windows, nao inicia Cua Driver e nao inicia processos manualmente. O GWRM e responsavel por reconciliar Godot headless, LSP, Godot MCP, GUT, Computer Use e cleanup.
