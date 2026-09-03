param([string]$ConfigPath = (Join-Path $PSScriptRoot "gwrm.config.json"))
$ErrorActionPreference = "Stop"
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$npm = [string]$config.paths.npm_executable
if ([string]::IsNullOrWhiteSpace($npm)) { throw "paths.npm_executable nao configurado." }
Push-Location $PSScriptRoot
try {
    & $npm install --omit=dev
    exit $LASTEXITCODE
}
finally { Pop-Location }
