# GWRM Computer Use (v1.1.0)

## Objetivo

Adicionar automacao grafica generica de cenas Godot ao mesmo lifecycle do GWRM, sem X11 no Docker e sem um segundo gateway administrado pelo usuario.

```text
Hermes / Docker
      |
      | MCP :8123
      v
GWRM MCP Facade
      |
      v
Supervisor GWRM / Windows
      |-- SessionManager -> Godot headless/LSP + Godot MCP por worktree
      |-- GutRunner       -> Godot headless pontual
      `-- ComputerUseService -> cua-driver mcp -> Windows Desktop
                                      |
                                      `-> janelas Godot graficas da worktree
```

`start-gwrm.bat` continua sendo o unico comando de startup. No Windows, `cua-driver mcp` e iniciado como processo filho do supervisor e encerra quando o GWRM fecha.

## Escopo de seguranca

O Computer Use nao e exposto como controle arbitrario do desktop. Toda operacao GUI exige `worktree_name` e `window_id`.

O GWRM:

1. resolve o path Windows da worktree registrada;
2. consulta processos cuja command line referencia esse path;
3. aceita somente processos com nome Godot;
4. exclui o PID headless persistente da sessao;
5. exclui processos cuja command line contem `--headless`;
6. cruza os PIDs restantes com `cua-driver list_windows`;
7. recusa qualquer `window_id` fora desse conjunto.

Isso permite operar qualquer cena ou editor Godot da worktree sem hardcode de UI/cena.

## Politica de tokens: semantic-first

`gui_inspect_window` chama `get_window_state` com `include_screenshot=false`. A resposta prioriza a arvore de acessibilidade estruturada e `element_token`.

Fluxo recomendado:

```text
gui_wait_for_window
 -> gui_inspect_window(query=...)
 -> gui_click(element_token=...)
 -> gui_inspect_window(query=...)
```

Somente quando a UI nao aparece semanticamente:

```text
gui_capture_window
 -> acao por coordenadas
```

A captura visual limita a maior dimensao por `computer_use.max_image_dimension` (padrao 900).

## Background-first

As tools de acao usam `delivery_mode=background` por padrao. Use `foreground` apenas quando uma acao nao funcionar em background. O Cua Driver restaura o foco anterior apos a acao foreground quando a plataforma suporta esse caminho.

## Tools

- `gui_status`
- `gui_list_windows`
- `gui_wait_for_window`
- `gui_inspect_window`
- `gui_capture_window`
- `gui_wait_for_element`
- `gui_click`
- `gui_type_text`
- `gui_press_key`
- `gui_hotkey`
- `gui_scroll`

As esperas acontecem dentro do GWRM para evitar polling repetitivo pelo agente.

## Configuracao

O bloco `computer_use` e opcional. Se estiver ausente, os defaults sao:

```json
{
  "computer_use": {
    "enabled": true,
    "required": false,
    "command": "cua-driver",
    "args": ["mcp"],
    "protocol_version": "2024-11-05",
    "startup_timeout_seconds": 20,
    "request_timeout_seconds": 60,
    "permission_mode": "standard",
    "wait_timeout_seconds": 15,
    "max_wait_timeout_seconds": 60,
    "wait_poll_milliseconds": 500,
    "max_semantic_elements": 400,
    "max_semantic_depth": 16,
    "max_image_dimension": 900
  }
}
```

`required=false` faz o GWRM iniciar normalmente quando Cua ainda nao esta instalado, mostrando `Computer Use ... UNAVAILABLE`. Depois de instalar o driver, reinicie o GWRM.

## Instalacao do Cua Driver no Windows

No PowerShell:

```powershell
irm https://cua.ai/driver/install.ps1 | iex
```

Valide:

```powershell
cua-driver --version
cua-driver doctor
```

Nao inicie `cua-driver serve`, `autostart` ou outro proxy para uso pelo GWRM. Nesta arquitetura, o proprio supervisor inicia `cua-driver mcp` na sessao Windows interativa.

## Sequencia generica de teste

Depois de `run_project(worktree_name, scene)`:

1. `gui_wait_for_window(worktree_name)`
2. `gui_inspect_window(worktree_name, window_id, query="...")`
3. acao semantica usando `element_token`
4. nova inspecao para verificar o efeito
5. `gui_capture_window` somente se o estado nao puder ser confirmado semanticamente
6. `stop_project`

Nenhuma etapa conhece AI ARENA ou qualquer cena especifica.
