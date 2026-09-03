# Installation

## 1. Requirements

Install on the Windows host:

- Node.js 20 or newer;
- Godot 4.x console executable;
- npm;
- PowerShell;
- optional Cua Driver for graphical Computer Use.

Hermes may run in Docker/WSL as long as it can reach the Windows host through the configured MCP and control ports.

## 2. Install source dependencies

From the GWRM directory:

```powershell
.\install-dependencies.bat
```

or:

```powershell
npm install --omit=dev
```

Dependencies are pinned by `package.json`/`package-lock.json` when the lock file is present.

## 3. Create local configuration

Copy the safe example:

```powershell
Copy-Item .\gwrm.config.example.json .\gwrm.config.json
```

Generate a local API key:

```powershell
.\generate-api-key.ps1
```

Paste the generated value into `service.api_key`.

Configure:

- `paths.godot_executable`
- `paths.windows_workspace_root`
- `paths.container_workspace_root`
- `paths.windows_worktrees_root`
- `paths.container_worktrees_root`

`gwrm.config.json` is ignored by Git and must remain local.

## 4. Optional Computer Use

Install Cua Driver according to its official installation instructions, then verify:

```powershell
cua-driver --version
cua-driver doctor
```

With `computer_use.required=false`, a missing driver does not prevent the Godot/LSP/GUT parts of GWRM from starting.

## 5. Start and stop

Start:

```powershell
.\start-gwrm.bat
```

A healthy startup prints a summary similar to:

```text
GWRM READY

Godot Runtime ...... OK
GUT Runner ......... OK
Computer Use ....... OK
Windows Desktop .... OK
Cua Driver ......... OK
MCP Port ........... 8123
Control Port ....... 8130
```

Stop the complete stack with `CTRL+C` in the GWRM console.

## 6. Hermes

See `docs/HERMES_INTEGRATION.md` and the files under `hermes/`.
