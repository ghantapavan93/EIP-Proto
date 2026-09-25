# Start Backstop for a demo and prove it is ready, through the same gateway a
# viewer will use (http://localhost:$Port/api/...), not the API port.
#
#   powershell -ExecutionPolicy Bypass -File scripts\demo-up.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\demo-up.ps1 -Fresh   # drop the DB volume first
param([switch]$Fresh)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$Port = if ($env:BACKSTOP_UI_PORT) { $env:BACKSTOP_UI_PORT } else { "5173" }
$Base = "http://localhost:$Port"

if ($Fresh) {
    Write-Host "==> dropping the database volume (demo data is reseeded on start)"
    docker compose down -v
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "==> docker compose up --build -d"
docker compose up --build -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> waiting for $Base/api/health/deep"
$health = $null
for ($i = 0; $i -lt 90; $i++) {
    try {
        $candidate = Invoke-RestMethod -Uri "$Base/api/health/deep" -TimeoutSec 5
        if ($candidate.ready) { $health = $candidate; break }
    } catch { }
    Start-Sleep -Seconds 2
}
if ($null -eq $health) {
    Write-Error "not ready after 180 s - see: docker compose logs api"
    docker compose ps
    exit 1
}

Write-Host ""
foreach ($c in $health.components) {
    $tag = if ($c.required) { "" } else { "  (optional)" }
    Write-Host ("  {0,-10} {1,-9} {2}{3}" -f $c.name, $c.state, $c.detail, $tag)
}
Write-Host ""
Write-Host ("  overall    {0}" -f $health.status.ToUpper())
if ($health.default_credentials) {
    Write-Host ""
    Write-Host "  NOTE: demo accounts still use password == username. Fine on localhost;"
    Write-Host "        set BACKSTOP_USERS in .env before running scripts\demo-tunnel.ps1."
}
Write-Host ""
Write-Host "Backstop is up:  $Base"
Write-Host "Public URL:      powershell -ExecutionPolicy Bypass -File scripts\demo-tunnel.ps1"
