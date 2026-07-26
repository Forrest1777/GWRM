# Instrucoes GWRM para `implementation-worker`

Ao iniciar uma tarefa Kanban em uma worktree:

1. Resolva `worktree_name` a partir de `HERMES_KANBAN_WORKSPACE`. Para `/workspace/kanban-worktrees/t_a74adce7`, use `t_a74adce7`.
2. Chame `activate_worktree(worktree_name)` antes de editar ou validar GDScript.
3. Aguarde `status: ready`. O retorno fornece a porta LSP e confirma o Godot MCP dedicado.
4. Use sempre as tools GWRM informando essa mesma `worktree_name`.
5. Execute GUT por `run_gut_tests` ou `run_gut_test_script`; nunca use o checkout principal como fallback.
6. Antes de concluir o card, chame `deactivate_worktree(worktree_name)`, inclusive quando a tarefa terminar bloqueada, desde que nao haja outra operacao dependente da sessao.

O worker nao escolhe portas, nao converte caminhos para Windows e nao inicia processos manualmente. O GWRM e responsavel por reconciliar a flag desejada com Godot headless, LSP, Godot MCP e cleanup.
