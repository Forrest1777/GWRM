# Instalacao

1. Extraia a pasta para `E:\dev\ai_agents\GWRM`.
2. Copie `gwrm.config.example.json` para `gwrm.config.json`.
3. Ajuste caminhos, portas e limites. Execute `generate-api-key.ps1` para gerar `service.api_key`, ou informe manualmente uma chave com pelo menos 32 caracteres.
4. Execute `install-dependencies.bat` uma vez, ou deixe `start-gwrm.bat` instalar automaticamente.
5. Execute `start-gwrm.bat` e mantenha a janela aberta.
6. Teste `http://localhost:8130/health`.
7. Execute `hermes\install-hermes-integration.ps1` para instalar o plugin atualizado no worker.
8. Mescle `hermes\config-snippet-worker.yaml` no profile `implementation-worker`.
9. Remova ou desabilite as entradas MCP antigas `godot` e `gut`, pois o GWRM as substitui.
10. Reinicie o container Hermes e inicie uma nova sessao do profile.

## Teste pelo container

```powershell
docker compose exec hermes sh -lc "curl -i http://host.docker.internal:8130/health"
```

Depois, pelo agente, chame:

```text
activate_worktree(worktree_name="<TASK_ID>")
get_worktree_status(worktree_name="<TASK_ID>")
run_gut_tests(worktree_name="<TASK_ID>", test_directory="res://tests/skill_system/ai_system")
# copie operation_id do retorno e consulte ate terminal=true
get_gut_run_status(operation_id="<OPERATION_ID>")
deactivate_worktree(worktree_name="<TASK_ID>")
```

## Rede e relay LSP

O Godot escuta localmente na faixa `lsp_start`–`lsp_end`. O GWRM publica um relay na faixa `lsp_proxy_start`–`lsp_proxy_end`, permitindo o acesso do container sem depender do bind configurado no editor Godot. Restrinja essas portas pelo Firewall do Windows ao ambiente local/Docker.
