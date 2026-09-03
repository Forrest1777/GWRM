# GWRM — Godot Worktree Runtime Manager

GWRM is a Windows-hosted runtime gateway for Hermes/Docker. A single process started with `start-gwrm.bat` exposes stable MCP and control endpoints while supervising isolated Godot runtimes per worktree, GUT test processes, Godot MCP instances, dynamic LSP/DAP ports, and optional Cua Driver computer use.

## Key features

- One stable MCP endpoint for Hermes.
- Worktree activation/deactivation by `worktree_name`.
- One persistent headless Godot editor per active worktree for LSP/DAP/import/class cache.
- One dedicated `@coding-solo/godot-mcp` process per active worktree.
- Supervised GUT runs with operation IDs and deterministic result collection.
- Safe Windows/container path mapping and per-worktree dynamic ports.
- Persistent desired state, restart recovery, and periodic reconciliation.
- Generic graphical Computer Use through Cua Driver, scoped to graphical Godot processes belonging to the requested worktree.
- Semantic-first GUI inspection; screenshots are opt-in fallbacks.
- One user-facing lifecycle: start with `start-gwrm.bat`, stop with `CTRL+C`.

## Requirements

- Windows 10/11 with an interactive desktop session.
- Node.js 20 or newer.
- Godot 4.x console executable.
- npm access during first dependency installation.
- Optional for graphical automation: current Cua Driver installed on the Windows host.

## Quick start

1. Copy `gwrm.config.example.json` to `gwrm.config.json`.
2. Replace the placeholder API key. You can run `./generate-api-key.ps1`.
3. Configure Godot/workspace/worktree paths for your environment.
4. Run `install-dependencies.bat` once, or let `start-gwrm.bat` install missing npm dependencies automatically.
5. If Computer Use is enabled, install Cua Driver and verify `cua-driver doctor` succeeds in the interactive Windows session.
6. Start GWRM with `start-gwrm.bat`.

See `docs/INSTALLATION.md`, `docs/ARCHITECTURE.md`, and `docs/COMPUTER_USE.md`.
