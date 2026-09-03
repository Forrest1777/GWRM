# Addendum de arquitetura - GWRM 1.1.0

## Computer Use

O Supervisor passa a possuir um `ComputerUseService`. Quando habilitado ele inicia `cua-driver mcp` como subprocesso stdio e encerra o cliente durante shutdown.

O Cua Driver nao e registrado diretamente no Hermes. O Hermes continua possuindo apenas a facade MCP do GWRM em `:8123`.

```text
Hermes -> GWRM MCP -> Supervisor -> ComputerUseService -> Cua Driver -> Windows Desktop
```

A associacao GUI e worktree-bound: somente janelas de processos Godot graficos cuja command line referencia o path da worktree podem ser controladas.

## Execucao grafica

Nao foi criado um segundo launcher de Godot. `run_project`, ja fornecido pelo Godot MCP dedicado, continua sendo o owner da execucao grafica. Computer Use apenas descobre e interage com a janela resultante.

## Observacao

A politica e semantic-first. Screenshots sao opt-in por `gui_capture_window`; `gui_inspect_window` nao inclui imagem por padrao.

## Lifecycle do usuario

Permanece inalterado:

```text
start-gwrm.bat
...
CTRL+C
```

O shutdown do GWRM encerra sessoes Godot e o runtime Cua supervisionado.
