# Instrucoes GWRM para `implementation-worker`

Ao iniciar uma tarefa Kanban em uma worktree:

1. Resolva e valide `HERMES_KANBAN_WORKSPACE`; o dispatcher já deve ter materializado a worktree.
2. Execute a skill `worktree-preflight` e prossiga somente com `passed: true`.
3. Resolva `worktree_name` pelo basename. Para `/workspace/skill_system_framework/.worktrees/t_a74adce7`, use `t_a74adce7`.
4. Chame `activate_worktree(worktree_name)` antes de editar ou validar GDScript.
5. Aguarde `status: ready`. O retorno fornece a porta LSP e confirma o Godot MCP dedicado.
6. Use sempre as tools GWRM informando essa mesma `worktree_name`.
7. Execute GUT por `run_gut_tests` ou `run_gut_test_script`; nunca use o checkout principal como fallback.
8. Antes de concluir o card, chame `deactivate_worktree(worktree_name)` e confirme `status: stopped`, `residual_pids: []` e `directory_released: true`.

O worker nao escolhe portas, nao converte caminhos para Windows e nao inicia processos manualmente. O GWRM e responsavel por reconciliar a flag desejada com Godot headless, LSP, Godot MCP e cleanup.
