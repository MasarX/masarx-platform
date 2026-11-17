param(
  [string]$EnvFile = "",
  [switch]$SkipHttp
)

$ErrorActionPreference = 'Stop'

function Get-Kv([string]$path, [string]$key) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $line = Get-Content -LiteralPath $path | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^$key=", '').Trim('"')
}

if (-not $EnvFile) { $EnvFile = $env:ENV_FILE }

$db = if ($env:DATABASE_URL) { $env:DATABASE_URL } else { $null }
$url = if ($env:SUPABASE_URL) { $env:SUPABASE_URL } else { $null }

if (-not $db) {
  if (-not $EnvFile) { $EnvFile = "config/env/.env.cloud" }
  $db = Get-Kv -path $EnvFile -key 'DATABASE_URL'
  if (-not $url) { $url = Get-Kv -path $EnvFile -key 'SUPABASE_URL' }
}
if (-not $db) { throw "DATABASE_URL missing in process env and $EnvFile" }
if (-not $SkipHttp -and -not $url) { Write-Warning "SUPABASE_URL missing; HTTP checks skipped" }

Write-Host "[quick-check] ENV_FILE=$EnvFile"

try {
  if (-not $SkipHttp -and $url) {
    $ping = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 10 -ErrorAction Stop
    Write-Host "[quick-check] HTTP $url -> $($ping.StatusCode)"
  }
} catch {
  Write-Warning "[quick-check] HTTP check failed: $($_.Exception.Message)"
}

try {
  $out = & psql "$db" -t -A -c 'select 1 as ok;' 2>$null
  if ($LASTEXITCODE -ne 0) { throw "psql exited $LASTEXITCODE" }
  Write-Host "[quick-check] DB OK -> $out"
} catch {
  Write-Error "[quick-check] DB query failed: $($_.Exception.Message)"
  exit 1
}

Write-Host "[quick-check] Ready for migrations/tests"
