# Relatório de validação

## Validações executadas

- verificação de sintaxe de todos os arquivos `.mjs`;
- compilação sintática do plugin Python e do bridge LSP;
- testes de segurança de nomes de worktree e caminhos `res://`;
- teste do parser de resultado GUT, incluindo falso positivo com exit code zero;
- teste integrado com Godot simulado:
  - criação do cache de `class_name`;
  - porta LSP interna;
  - relay LSP externo;
  - Godot MCP dedicado;
  - roteamento de `projectPath` para a worktree;
  - execução GUT;
  - desativação e cleanup;
- teste do facade MCP delegando a um supervisor singleton.

Resultado final no ambiente de construção:

```text
8 testes executados
8 testes aprovados
0 testes falhando
```

## Limites da validação

Este ambiente não executa binários Windows nem o Godot 4.6 real. Portanto, ainda precisam ser validados no computador de destino:

- inicialização real de `Godot_v4.6-stable_win64_console.exe` com `--headless --editor`;
- handshake real com `@coding-solo/godot-mcp@0.1.1`;
- acesso do container Docker ao relay LSP;
- execução da suíte GUT real;
- comportamento do encerramento por `CTRL+C` no console Windows;
- regras do Firewall do Windows para as faixas configuradas.
