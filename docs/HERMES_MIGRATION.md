# Migrating Hermes to GWRM

This historical migration document is retained in generic form for repositories that still use the pre-GWRM Godot/GUT integrations.

## Worker migration

1. Back up the worker profile configuration.
2. Install the GWRM Godot LSP plugin and bridge with `hermes/install-hermes-integration.ps1`.
3. Replace static Godot LSP configuration with `hermes/config-snippet-worker.yaml`.
4. Remove legacy direct `godot` and `gut` MCP entries to avoid duplicated tools.
5. Add the single `mcp_servers.gwrm` entry.
6. Merge `hermes/WORKER_INSTRUCTIONS.md` into the worker's persistent instructions.
7. Replace every placeholder path/API key in the snippets with deployment-specific values.

## Orchestrator migration

The orchestrator should normally use the reduced surface from `hermes/config-snippet-orchestrator.yaml`. Install the dynamic LSP plugin there only when the orchestrator truly needs per-worktree GDScript LSP.

Restart Hermes after changing profile plugins or configuration. Existing agent sessions may not reload changed plugins automatically.
