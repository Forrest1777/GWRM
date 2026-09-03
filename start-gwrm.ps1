param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "gwrm.config.json")
)

$ErrorActionPreference = "Stop"
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path $ConfigPath)) {
    throw "Configuration file not found: $ConfigPath. Copy gwrm.config.example.json to gwrm.config.json and edit it first."
}
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$node = [string]$config.paths.node_executable
$npm = [string]$config.paths.npm_executable
if ([string]::IsNullOrWhiteSpace($node)) { throw "paths.node_executable is not configured." }
if ([string]::IsNullOrWhiteSpace($npm)) { throw "paths.npm_executable is not configured." }

Push-Location $PSScriptRoot
try {
    if (-not (Test-Path "node_modules\.bin\mcp-proxy.cmd") -or -not (Test-Path "node_modules\@coding-solo\godot-mcp\build\index.js")) {
        Write-Host "Dependencies were not found. Running npm install..."
        & $npm install --omit=dev
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
    }
    Write-Host ""
    Write-Host "Starting Godot Worktree Runtime Manager..."
    Write-Host "Configuration: $ConfigPath"
    Write-Host "Press CTRL+C to stop GWRM."
    Write-Host ""
    & $node "src\launcher.mjs" --config $ConfigPath
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
