$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    Write-Host "Installing pinned GWRM npm dependencies..."
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
    Write-Host "Dependencies installed successfully."
}
finally {
    Pop-Location
}
