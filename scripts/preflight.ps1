# Backstop demo preflight: one command, read-only, safe while reviewers are signed in.
#
#   powershell -ExecutionPolicy Bypass -File scripts\preflight.ps1
#
# Checks the local stack and the public link exactly as a reviewer reaches them, and
# exits 1 on the first problem. It changes nothing: no reseed, no restart, no login.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$Port = if ($env:BACKSTOP_UI_PORT) { $env:BACKSTOP_UI_PORT } else { "5173" }
$Local = "http://localhost:$Port"
$failures = 0

function Check([string]$name, [scriptblock]$test) {
    try {
        $detail = & $test
        Write-Host ("  PASS  {0,-34} {1}" -f $name, $detail)
    } catch {
        Write-Host ("  FAIL  {0,-34} {1}" -f $name, $_.Exception.Message) -ForegroundColor Red
        $script:failures++
    }
}

function Get-Status([string]$url) {
    try { return (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 30).StatusCode }
    catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { throw } }
}

Write-Host "Backstop preflight"

$health = $null
Check "stack ready (deep health)" {
    $script:health = Invoke-RestMethod -Uri "$Local/api/health/deep" -TimeoutSec 30
    if (-not $script:health.ready) { throw "not ready: $($script:health.status)" }
    "$($script:health.status); database $($script:health.database)"
}
Check "rule corpus and inventory" {
    if ($script:health.rules -lt 13 -or $script:health.artifacts -lt 24) { throw "rules $($script:health.rules), artifacts $($script:health.artifacts)" }
    "$($script:health.rules) rules, $($script:health.artifacts) artifacts, $($script:health.contracts) contracts"
}
Check "development and held-out calls" {
    if ($script:health.transcripts -lt 60 -or $script:health.holdout_transcripts -lt 60) { throw "dev $($script:health.transcripts), held-out $($script:health.holdout_transcripts)" }
    "$($script:health.transcripts) development, $($script:health.holdout_transcripts) held-out"
}
Check "no default passwords" {
    if ($script:health.default_credentials) { throw "an account still has password == username" }
    "all accounts have real passwords"
}
Check "API refuses anonymous access" {
    $code = Get-Status "$Local/api/runs"
    if ($code -ne 401) { throw "expected 401, got $code" }
    "401 without login"
}

$link = if (Test-Path .demo-link.txt) { (Get-Content .demo-link.txt -Raw).Trim() } else { "" }
Check "public link recorded" {
    if (-not $link) { throw "no .demo-link.txt; run scripts\demo-keepalive.ps1" }
    $link
}
if ($link) {
    foreach ($path in @("/", "/runs/compare", "/governance", "/api/health")) {
        Check "public $path" {
            $code = Get-Status "$link$path"
            if ($code -ne 200) { throw "HTTP $code" }
            "200"
        }
    }
}

if ($failures) {
    Write-Host "PREFLIGHT FAILED: $failures check(s)." -ForegroundColor Red
    exit 1
}
Write-Host "PREFLIGHT OK: safe to send the link." -ForegroundColor Green
