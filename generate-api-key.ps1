param([string]$ConfigPath = (Join-Path $PSScriptRoot "gwrm.config.json"))
$ErrorActionPreference = "Stop"
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$key = -join ($bytes | ForEach-Object { $_.ToString("x2") })
$config.service.api_key = $key
$config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
Write-Host "Nova chave gravada em service.api_key."
Write-Host "Copie este valor para <GWRM_API_KEY> nos configs Hermes:"
Write-Host $key
