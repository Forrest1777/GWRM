# Correções de worktree e cleanup

## Alterações

- alinhamento dos exemplos, snippets, bridge e plugin ao root `/workspace/skill_system_framework/.worktrees`;
- atualização automática de paths persistidos em `state/<worktree>.json` quando a configuração de root muda;
- preflight obrigatório incluído no pacote de integração Hermes;
- fechamento aguardado do cliente Godot MCP e dos streams de log;
- encerramento da árvore de processos conhecida antes de publicar `stopped`;
- busca e encerramento direcionado de processos Godot residuais que ainda referenciem o path da worktree no Windows;
- novos campos de status: `residual_pids` e `directory_released`;
- `status: stopped` somente depois da verificação de ausência de processos Godot residuais gerenciáveis;
- novo teste para migração de state com roots antigos.

## Validação executada

```text
npm test
16 testes aprovados, 0 falhas

npm run check
Sintaxe JavaScript válida
```

## Limite da garantia

`directory_released: true` confirma que o GWRM encerrou seus processos conhecidos e não encontrou processos Godot cuja linha de comando ainda referencie a worktree. Software externo, antivírus, Explorer ou ferramentas não iniciadas pelo GWRM ainda podem manter handles; nesses casos, o erro deve ser investigado no host.
