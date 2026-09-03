param(
    [Parameter(Mandatory = $true)]
    [string]$HermesData,
    [switch]$InstallOrchestratorPlugin
)

$ErrorActionPreference = "Stop"
$PluginSource = Join-Path $PSScriptRoot "plugin\godot-lsp"
$BridgeSource = Join-Path $PSScriptRoot "bin\godot-lsp-bridge"
$BinDirectory = Join-Path $HermesData "bin"
$Profiles = @("implementation-worker")
if ($InstallOrchestratorPlugin) { $Profiles += "implementation-orchestrator" }

New-Item -ItemType Directory -Force $BinDirectory | Out-Null
Copy-Item -Force $BridgeSource (Join-Path $BinDirectory "godot-lsp-bridge")

foreach ($Profile in $Profiles) {
    $Target = Join-Path $HermesData "profiles\$Profile\plugins\godot-lsp"
    if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
    New-Item -ItemType Directory -Force (Split-Path $Target) | Out-Null
    Copy-Item -Recurse -Force $PluginSource $Target
    Write-Host "Plugin installed at $Target"
}

Write-Host "Bridge installed at $(Join-Path $BinDirectory 'godot-lsp-bridge')"
Write-Host "Merge the YAML snippets into the relevant profile configs and restart Hermes."
