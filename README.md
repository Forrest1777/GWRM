# GWRM — Godot Worktree Runtime Manager

Pasta portátil, iniciada manualmente por `start-gwrm.bat`, para Windows que unifica o acesso do Hermes/Docker a Godot LSP, Godot MCP e GUT em worktrees isoladas.

## Caracteristicas

- endpoint MCP único e estável para o Hermes;
- ativação e desativação por `worktree_name`;
- Godot headless persistente por worktree, responsável por carregar/importar o projeto e fornecer LSP;
- Godot MCP dedicado por worktree, isolando `activeProcess`;
- GUT compartilhado com processo pontual e validação real de sucesso;
- mapeamento seguro entre `/workspace` e o workspace Windows;
- portas LSP/DAP exclusivas;
- estado persistente, restauração após restart e reconciliação periódica;
- remoção automática quando a worktree for apagada;
- configuração externa em `gwrm.config.json`;
- inicialização manual por `start-gwrm.bat`.

Consulte `docs/INSTALLATION.md` e `docs/ARCHITECTURE.md`.

## Dependencias

- Windows;
- Node.js 20 ou superior;
- Godot 4.6 console;
- acesso npm na primeira instalação para versões fixadas:
  - `@coding-solo/godot-mcp@0.1.1`;
  - `mcp-proxy@6.5.4`.

Nenhuma chave real é incluída. Gere uma nova chave para `service.api_key`.

## Validação

Consulte `docs/VALIDATION.md`. O pacote possui testes automatizados com processos simulados, mas a validação final com Godot/Windows deve ser realizada no ambiente de destino.
