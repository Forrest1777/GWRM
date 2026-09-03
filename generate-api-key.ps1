param([int]$Bytes = 32)

if ($Bytes -lt 32 -or $Bytes -gt 64) {
    throw "Bytes must be between 32 and 64, producing a 64-128 character hexadecimal key."
}
$buffer = New-Object byte[] $Bytes
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
$key = -join ($buffer | ForEach-Object { $_.ToString("x2") })
Write-Output $key
