# Stop the Backstop demo stack.
#
#   powershell -ExecutionPolicy Bypass -File scripts\demo-down.ps1          # stop, keep the data
#   powershell -ExecutionPolicy Bypass -File scripts\demo-down.ps1 -Reset   # stop and delete the database
#
# A public tunnel (demo-tunnel.ps1 / demo-keepalive.ps1) is a separate process: stop it
# first, or it will report the stack as down.
param([switch]$Reset)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if ($Reset) {
    Write-Host "==> docker compose down -v (deletes the database volume; the demo reseeds on next start)"
    docker compose down -v
} else {
    Write-Host "==> docker compose down (the database volume is kept)"
    docker compose down
}
exit $LASTEXITCODE
