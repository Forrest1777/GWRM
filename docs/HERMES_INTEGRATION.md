# Hermes Integration

GWRM exposes two host endpoints by default:

- MCP: `http://host.docker.internal:8123/mcp`
- Control API: `http://host.docker.internal:8130`

The exact ports are configurable.

## MCP facade

Merge `hermes/config-snippet-worker.yaml` into the worker profile and replace `<GWRM_API_KEY>` with the same local key configured in GWRM.

The worker MCP server is named `gwrm` and exposes lifecycle, Godot MCP, GUT, and Computer Use tools through one stable endpoint.

## GDScript LSP

The Hermes Godot LSP plugin does not hardcode a dynamic LSP port. Its bridge derives the worktree from the project root, asks the GWRM Control API to ensure the worktree runtime, receives the current LSP relay port, and forwards stdio LSP traffic over TCP.

Environment values in the provided YAML snippets are examples. Adjust the generic workspace roots to the actual Docker and Windows roots in your deployment.

## Orchestrator

The orchestrator snippet intentionally exposes a smaller surface. It may inspect GWRM status and run/collect validation without becoming the default owner of worker worktree lifecycle or graphical input.
