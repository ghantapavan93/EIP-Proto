# Keep the public demo up for a few hours, unattended.
#
#   powershell -ExecutionPolicy Bypass -File scripts\demo-keepalive.ps1            # 6 hours
#   powershell -ExecutionPolicy Bypass -File scripts\demo-keepalive.ps1 -Hours 3
#   powershell -ExecutionPolicy Bypass -File scripts\demo-keepalive.ps1 -Hours 10 -Adopt
#
# -Adopt keeps the link already sent: if a tunnel for this stack is running and its URL
# (from .demo-link.txt) answers, the keep-alive watches that tunnel instead of starting a
# new one. Stop the previous keep-alive first; two would both restart the tunnel.
#
# While it runs it:
#   - asks Windows not to idle-sleep (SetThreadExecutionState, like a video player;
#     no power settings are changed, and a closed lid still sleeps)
#   - keeps ONE Cloudflare Quick Tunnel alive and writes its URL to .demo-link.txt
#   - checks the local stack and the public URL every 60 s; restarts the Docker
#     stack if the API stops answering, and the tunnel if it dies or stops serving
#
# A restarted Quick Tunnel gets a NEW random URL. .demo-link.txt and the log
# always hold the current one; the old link stops working.
param([double]$Hours = 6, [switch]$Adopt)

$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")
$Root = (Get-Location).Path
$LinkFile = Join-Path $Root ".demo-link.txt"
$LogFile = Join-Path $Root ".demo-keepalive.log"
$Local = "http://localhost:5173"

function Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    Write-Host $line
}

# ---- stay awake (released automatically when this process exits)
Add-Type -Namespace Backstop -Name Power -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
"@
$ES_CONTINUOUS = [uint32]"0x80000000"; $ES_SYSTEM_REQUIRED = [uint32]"0x00000001"
[void][Backstop.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

# ---- cloudflared
$Cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $Cloudflared) {
    $portable = Join-Path $env:LOCALAPPDATA "Programs\cloudflared\cloudflared.exe"
    if (Test-Path $portable) { $Cloudflared = $portable }
}
if (-not $Cloudflared) { Log "cloudflared not found - install it first"; exit 1 }

function Test-Url([string]$url) {
    try { return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } catch { return $false }
}

function Ensure-Stack {
    if (Test-Url "$Local/api/health/deep") { return $true }
    Log "local stack not answering - docker compose up -d"
    docker compose up -d 2>&1 | Out-Null
    for ($i = 0; $i -lt 60; $i++) { if (Test-Url "$Local/api/health/deep") { Log "local stack healthy"; return $true }; Start-Sleep 3 }
    Log "local stack still down - check Docker Desktop"
    return $false
}

$script:Tunnel = $null
$script:Url = $null
function Start-Tunnel {
    if ($script:Tunnel -and -not $script:Tunnel.HasExited) { Stop-Process -Id $script:Tunnel.Id -Force -ErrorAction SilentlyContinue }
    # Same guard as demo-tunnel.ps1: never publish while any account has password == username.
    try { $health = Invoke-RestMethod -Uri "$Local/api/health/deep" -TimeoutSec 10 } catch { $health = $null }
    if (-not $health -or $health.default_credentials) {
        Log "refusing to publish: stack not healthy or demo accounts still use password == username (set BACKSTOP_USERS in .env)"
        $script:Url = $null
        return
    }
    $tlog = Join-Path $env:TEMP ("backstop-tunnel-{0}.log" -f (Get-Date -Format "HHmmss"))
    $script:Tunnel = Start-Process -FilePath $Cloudflared -ArgumentList @("tunnel", "--no-autoupdate", "--url", $Local, "--logfile", $tlog) -PassThru -WindowStyle Hidden
    $script:Url = $null
    for ($i = 0; $i -lt 60 -and -not $script:Url; $i++) {
        Start-Sleep 2
        if (Test-Path $tlog) {
            $m = Select-String -Path $tlog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -Last 1
            if ($m) { $script:Url = $m.Matches[0].Value }
        }
    }
    if (-not $script:Url) { Log "tunnel did not report a URL"; return }
    # A new hostname can take a few seconds to resolve worldwide.
    for ($i = 0; $i -lt 12; $i++) { if (Test-Url "$($script:Url)/api/health/deep") { break }; Start-Sleep 5 }
    Set-Content -Path $LinkFile -Value $script:Url -Encoding utf8
    Log "PUBLIC LINK: $($script:Url)"
}

function Adopt-Tunnel {
    if (-not (Test-Path $LinkFile)) { return $false }
    $url = (Get-Content $LinkFile -Raw).Trim()
    $proc = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
        Where-Object { $_.CommandLine -match [regex]::Escape("--url $Local") } | Select-Object -First 1
    if (-not $url -or -not $proc -or -not (Test-Url "$url/api/health/deep")) { return $false }
    $script:Tunnel = Get-Process -Id $proc.ProcessId
    $script:Url = $url
    Log "adopted running tunnel (pid $($proc.ProcessId)); link unchanged: $url"
    return $true
}

Log "keep-alive started for $Hours h"
[void](Ensure-Stack)
if (-not ($Adopt -and (Adopt-Tunnel))) { Start-Tunnel }
$deadline = (Get-Date).AddHours($Hours)
$misses = 0
while ((Get-Date) -lt $deadline) {
    Start-Sleep 60
    $stackOk = Ensure-Stack
    if (-not $script:Tunnel -or $script:Tunnel.HasExited) { Log "tunnel process exited - restarting (the link will change)"; Start-Tunnel; $misses = 0; continue }
    if ($stackOk -and $script:Url) {
        if (Test-Url "$($script:Url)/api/health/deep") { $misses = 0 }
        else {
            $misses++
            Log "public URL did not answer ($misses/3)"
            if ($misses -ge 3) { Log "restarting tunnel (the link will change)"; Start-Tunnel; $misses = 0 }
        }
    }
}
Log "keep-alive finished; tunnel left running"
