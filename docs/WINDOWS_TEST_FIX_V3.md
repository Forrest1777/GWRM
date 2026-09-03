# Windows Test Fixes v3 — Historical Note

This retained historical note documents Windows-specific reliability fixes that remain part of the current implementation.

- Test paths use `fileURLToPath(import.meta.url)` rather than URL pathname assumptions.
- The test suite runs sequentially with `--test-concurrency=1` to reduce races between processes, ports, and cleanup.
- Tests wait for supervisor/facade process closure before deleting temporary directories.
- Supervisor stderr is surfaced when health checks fail.
- Godot and Godot MCP child-process shutdown waits for real `close` events before stream cleanup.
- Runtime cleanup avoids competing shutdown paths for the same child streams.

Native `taskkill`, CIM/PowerShell, interactive-desktop, and handle behavior still require validation on the target Windows host.
