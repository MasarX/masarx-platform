param(
  [string]$ParentEnvFile = "config/env/.env.cloud",
  [Parameter(Mandatory = $true, HelpMessage = 'Pass the path to the isolate environment file.')][string]$IsolateEnvFile,
  [int]$MaxMinutes = 30
)

$ErrorActionPreference = 'Stop'

function Get-DbUrl([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { throw "ENV file not found: $path" }
  $line = Get-Content -LiteralPath $path | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace '^DATABASE_URL=','').Trim('"')
}

function Start-DbDiff([string]$envFile) {
  $lock = 'tmp/dbdiff.lock'
  if (Test-Path $lock) { return }
  New-Item -ItemType Directory -Force -Path 'tmp' | Out-Null
  Set-Content -Path $lock -Value (Get-Date).ToString('s') -NoNewline
  $dbUrl = Get-DbUrl $envFile
  if (-not $dbUrl) { Write-Host "[monitor] Parent DATABASE_URL missing; skip diff"; Remove-Item $lock -Force; return }
  $cmd = "npx -y supabase@2 db diff --db-url `"$dbUrl`" --schema public --use-migra -f tmp\\cloud_recon_raw.sql --yes"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -NoNewWindow | Out-Null
  Write-Host "[monitor] Started db diff in background"
}

function TryCommitReconciliation() {
  $diff = 'tmp/cloud_recon_raw.sql'
  if (-not (Test-Path $diff)) { return $false }
  $len = (Get-Item $diff).Length
  if ($len -le 0) { return $false }
  $stamp = (Get-Date).ToString('yyyyMMddHHmmss')
  $target = "supabase/migrations/${stamp}_parent_reconciliation.sql"
  Copy-Item -LiteralPath $diff -Destination $target -Force
  Write-Host "[monitor] Reconciliation migration written: $target (size=$len bytes)"
  if (Test-Path 'tmp/dbdiff.lock') { Remove-Item 'tmp/dbdiff.lock' -Force }
  return $true
}

function TryPush([string]$envFile) {
  $dbUrl = Get-DbUrl $envFile
  if (-not $dbUrl) { Write-Host "[monitor] Isolate DATABASE_URL missing; skip push"; return }
  $cmd = "npx -y supabase@2 db push --db-url `"$dbUrl`" --include-all --yes"
  $res = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -NoNewWindow -PassThru
  $res.WaitForExit() | Out-Null
  Write-Host "[monitor] push exitcode=$($res.ExitCode)"
}

function CheckEdgeRoles([string]$envFile) {
  $dbUrl = Get-DbUrl $envFile
  if (-not $dbUrl) { return $false }
  $out = & psql $dbUrl -t -A -c "select count(*) from pg_roles where rolname in ('edge_api_caller_role','edge_webhook_role')"
  $cnt = 0
  if ($out) { [int]::TryParse($out.Trim(), [ref]$cnt) | Out-Null }
  return ($cnt -ge 2)
}

New-Item -ItemType Directory -Force -Path 'tmp' | Out-Null

$start = Get-Date
for ($i=0; $i -lt $MaxMinutes; $i++) {
  $ts = (Get-Date).ToString('HH:mm:ss')
  Write-Host "[monitor][$ts] tick $($i+1)/$MaxMinutes"

  if (-not (Test-Path 'tmp/dbdiff.lock') -and -not (Test-Path 'tmp/cloud_recon_raw.sql')) {
    try { Start-DbDiff -envFile $ParentEnvFile } catch { Write-Host "[monitor] Start-DbDiff error: $($_.Exception.Message)" }
  }

  $committed = $false
  try { $committed = TryCommitReconciliation } catch { Write-Host "[monitor] TryCommitReconciliation error: $($_.Exception.Message)" }

  try { TryPush -envFile $IsolateEnvFile } catch { Write-Host "[monitor] TryPush error: $($_.Exception.Message)" }

  $rolesOk = $false
  try { $rolesOk = CheckEdgeRoles -envFile $IsolateEnvFile } catch { }
  Write-Host "[monitor] isolate edge roles present = $rolesOk"

  if ($committed -and $rolesOk) {
    Write-Host "[monitor] Alignment complete (reconciliation + edge roles)."
    break
  }

  Start-Sleep -Seconds 60
}

Write-Host "[monitor] Done. Elapsed: $(((Get-Date)-$start).TotalMinutes.ToString('0.0')) min"
