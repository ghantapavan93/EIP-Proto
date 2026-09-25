# Expose the UI gateway (and only it) through a Cloudflare Quick Tunnel.
#
#   powershell -ExecutionPolicy Bypass -File scripts\demo-tunnel.ps1
#
# Quick Tunnels are for demos and development: a random *.trycloudflare.com URL,
# no uptime guarantee, a new URL every start. Production would use a named
# tunnel behind Cloudflare Access, or a normal cloud deployment (infra/terraform).
#
# Refuses to publish while the demo accounts still use password == username.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$Port = if ($env:BACKSTOP_UI_PORT) { $env:BACKSTOP_UI_PORT } else { "5173" }
$Base = "http://localhost:$Port"

$Cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $Cloudflared) {
    # Portable copy (no admin): Cloudflare's signed release exe dropped here.
    $portable = Join-Path $env:LOCALAPPDATA "Programs\cloudflared\cloudflared.exe"
    if (Test-Path $portable) { $Cloudflared = $portable }
}
if (-not $Cloudflared) {
    Write-Error "cloudflared is not installed: winget install --id Cloudflare.cloudflared"
    exit 1
}

try {
    $health = Invoke-RestMethod -Uri "$Base/api/health/deep" -TimeoutSec 5
} catch {
    Write-Error "Backstop is not running - scripts\demo-up.ps1 first"
    exit 1
}

if ($health.default_credentials) {
    Write-Host "Refusing to publish: the demo accounts still use password == username, and a"
    Write-Host "Quick Tunnel URL is reachable by anyone who has it."
    Write-Host ""
    Write-Host "Set real passwords in .env, then restart the API:"
    Write-Host "  BACKSTOP_USERS=pavan:<long-password>:engineer,reviewer:<long-password>:analyst,admin:<long-password>:admin"
    Write-Host "  docker compose up -d api"
    exit 1
}

Write-Host "==> publishing $Base (UI + /api only; Postgres, the API port and Ollama stay private)"
Write-Host "    fallback if the tunnel dies: run this again (new URL), or screen-share $Base"
& $Cloudflared tunnel --no-autoupdate --url $Base
