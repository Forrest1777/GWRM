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
  └─ cleanup quando active=false ou a worktree desaparece
```

## Estado desejado

O worker altera somente `desired_active` pelas tools `activate_worktree` e `deactivate_worktree`. O GWRM executa imediatamente a reconciliacao. A rotina periodica corrige crashes, processos ausentes e worktrees removidas.

## Persistencia

Cada worktree possui `state/<worktree_name>.json`. Worktrees ativas sao restauradas quando o GWRM inicia. Quando o diretorio da worktree deixa de existir, seus processos e seu registro sao removidos.

## Isolamento

Cada Godot MCP e um subprocesso stdio independente, portanto seu `activeProcess` pertence somente a uma worktree. `run_project`, `get_debug_output` e `stop_project` nao compartilham estado entre agentes.
