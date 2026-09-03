# Source Baseline

This source package was produced from the GWRM `main` branch baseline:

- repository: `Forrest1777/GWRM`
- baseline commit: `0198a67eee7263dc47529944171ebd2c363d10b2`
- baseline commit message (English translation): `GWRM update`
- package version: `1.1.0`

The 1.1.0 source adds the generic Computer Use subsystem and console worktree context while preserving the existing GWRM lifecycle, worktree isolation, Godot MCP routing, LSP bridge, and supervised GUT model.

The source distribution is intentionally sanitized:

- no local `gwrm.config.json`;
- no deployment API key;
- no host-specific workspace or Godot paths;
- no `node_modules`;
- no runtime logs, state records, audit output, or backups.

`gwrm.config.example.json` and `gwrm.config_DEFAULT.json` contain generic placeholders only.

The package does not contain a regenerated `package-lock.json` because the isolated packaging environment had no npm registry access. Direct dependencies remain pinned in `package.json`; run `npm install` in a networked development environment to generate/update the lock file before committing it if your repository policy requires a lock file.
