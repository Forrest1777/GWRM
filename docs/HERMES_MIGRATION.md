# Migração do Hermes para o GWRM

## Arquivos afetados

```text
E:\dev\ai_agents\hermes\hermes-data\config.yaml
E:\dev\ai_agents\hermes\hermes-data\profiles\implementation-worker\config.yaml
E:\dev\ai_agents\hermes\hermes-data\profiles\implementation-orchestrator\config.yaml
E:\dev\ai_agents\hermes\hermes-data\profiles\implementation-worker\plugins\godot-lsp\
E:\dev\ai_agents\hermes\hermes-data\bin\godot-lsp-bridge
```

## Worker

1. Faça backup do `config.yaml` do profile.
2. Instale o plugin e o bridge com `hermes\install-hermes-integration.ps1`.
3. Substitua a configuração LSP estática por `hermes\config-snippet-worker.yaml`.
4. Remova as entradas MCP antigas `godot` e `gut` do profile para evitar tools duplicadas.
5. Adicione a entrada única `mcp_servers.gwrm`.
6. Incorpore `hermes\WORKER_INSTRUCTIONS.md` às instruções persistentes do worker.

## Orquestrador

O orquestrador não controla `active`. Ele pode receber apenas as tools de consulta e GUT do snippet próprio. O plugin LSP dinâmico deve ser instalado no orquestrador somente se houver necessidade real de LSP em worktrees; o checkout principal pode continuar com sua integração específica.

## Reinício e verificação

```powershell
Set-Location "E:\dev\ai_agents\hermes\compose"
docker compose restart hermes
docker compose exec hermes hermes -p implementation-worker config get plugins.enabled
docker compose exec hermes hermes -p implementation-worker config get platform_toolsets.cli
```

Depois, inicie uma nova sessão worker pelo dispatcher Kanban. Sessões antigas não recarregam necessariamente plugins e configurações alterados.
