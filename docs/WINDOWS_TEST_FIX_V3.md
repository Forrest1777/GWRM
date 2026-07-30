# Correções v3 para testes no Windows

Esta revisão preserva o hotfix do probe PowerShell e corrige falhas observadas ao executar `npm test` no Windows.

## Alterações

- Usa `fileURLToPath(import.meta.url)` nos testes, evitando paths como `\\E:\\...` derivados de `URL.pathname`.
- Executa os arquivos de teste sequencialmente com `--test-concurrency=1` para evitar concorrência entre processos, portas e cleanup no Windows.
- Aguarda o encerramento real do supervisor e da facade antes de remover os diretórios temporários.
- Exibe stderr do supervisor quando o health check falhar.
- Aguarda o evento `close` dos processos Godot e Godot MCP antes de destruir pipes e streams.
- Evita encerramento concorrente dos mesmos streams por `#onGodotExit` e `#stopRuntime`.

## Validação executada no ambiente de geração

```text
npm test: 18 passed, 0 failed
npm run check: Sintaxe JavaScript valida
```

A validação final do comportamento nativo de `taskkill`, CIM/PowerShell e handles deve ser repetida no host Windows.
