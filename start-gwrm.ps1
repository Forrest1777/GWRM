param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "gwrm.config.json")
)

$ErrorActionPreference = "Stop"
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path $ConfigPath)) {
    throw "Arquivo de configuracao nao encontrado: $ConfigPath"
}
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$node = [string]$config.paths.node_executable
$npm = [string]$config.paths.npm_executable
if ([string]::IsNullOrWhiteSpace($node)) { throw "paths.node_executable nao configurado." }
if ([string]::IsNullOrWhiteSpace($npm)) { throw "paths.npm_executable nao configurado." }

Push-Location $PSScriptRoot
try {
    if (-not (Test-Path "node_modules\.bin\mcp-proxy.cmd") -or -not (Test-Path "node_modules\@coding-solo\godot-mcp\build\index.js")) {
        Write-Host "Dependencias nao encontradas. Executando npm install..."
        & $npm install --omit=dev
        if ($LASTEXITCODE -ne 0) { throw "npm install falhou com codigo $LASTEXITCODE." }
    }
    Write-Host ""
    Write-Host "Iniciando Godot Worktree Runtime Manager..."
    Write-Host "Configuracao: $ConfigPath"
    Write-Host "Para encerrar, pressione CTRL+C."
    Write-Host ""
    & $node "src\launcher.mjs" --config $ConfigPath
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
