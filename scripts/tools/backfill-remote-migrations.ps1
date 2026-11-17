param(
  [string]$EnvFile = ''
)

$ErrorActionPreference = 'Stop'

$resolvedEnvFile = if ($EnvFile) {
  $EnvFile
} elseif ($env:ENV_FILE) {
  $env:ENV_FILE
} else {
  'config/env/.env.cloud'
}

# Load env file (supports lines like KEY=VALUE or export KEY=VALUE) only when
# DATABASE_URL is not already set by the calling shell/runtime.
if (-not $env:DATABASE_URL) {
  if (!(Test-Path $resolvedEnvFile)) {
    throw "DATABASE_URL is not set and env file is missing: $resolvedEnvFile"
  }
  Get-Content $resolvedEnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $line = $_ -replace '^export\s+',''
    $kv = $line -split '=',2
    if ($kv.Length -ge 2) {
      $k = $kv[0].Trim()
      $v = $kv[1].Trim()
      if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length-2) }
      if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v = $v.Substring(1, $v.Length-2) }
      Set-Item -Path Env:$k -Value $v
    }
  }
}
if (-not $env:DATABASE_URL) { throw 'DATABASE_URL is not set. Provide it directly or via -EnvFile/ENV_FILE.' }

Write-Host "Connecting to cloud DB to read migration history..." -ForegroundColor Cyan

# Pull remote records
$sql = "select coalesce(json_agg(json_build_object('version', version, 'name', name, 'statements', statements) order by version), '[]'::json) from supabase_migrations.schema_migrations"
$remoteJson = & psql -X -q -t -A -d $env:DATABASE_URL -c $sql
if (-not $remoteJson) { throw 'Failed to retrieve remote migrations JSON (psql empty). Ensure psql is on PATH and DB is reachable.' }
$records = $remoteJson | ConvertFrom-Json

# Build lookup
$remoteByVersion = @{}
$remoteVersions = @()
foreach ($r in $records) { $remoteByVersion[[string]$r.version] = $r; $remoteVersions += [string]$r.version }

# Local versions from root of supabase/migrations only
$root = Resolve-Path 'supabase/migrations'
$localVersions = Get-ChildItem -Path $root -File | Where-Object { $_.Name -match '^[0-9]{12,}' } | ForEach-Object {
  if ($_.BaseName -match '^([0-9]{12,})') { $Matches[1] }
} | Sort-Object -Unique
$localSet = New-Object System.Collections.Generic.HashSet[string]
$localVersions | ForEach-Object { [void]$localSet.Add($_) }

# Compute missing
$missing = @()
foreach ($v in $remoteVersions) { if (-not $localSet.Contains($v)) { $missing += $v } }
if ($missing.Count -eq 0) { Write-Host 'No missing migrations. Histories already aligned.' -ForegroundColor Green; exit 0 }

Write-Host ("Missing versions: {0}" -f ($missing -join ', ')) -ForegroundColor Yellow

# Backfill files
[int]$created = 0
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($v in $missing) {
  $rec = $remoteByVersion[$v]
  if (-not $rec) { Write-Warning "No remote record found for version $v"; continue }
  $name = if ($rec.name) { [string]$rec.name } else { 'migration' }
  $slug = ($name -replace '[^A-Za-z0-9_]+','_').ToLower().Trim('_')
  if (-not $slug) { $slug = 'migration' }
  $file = Join-Path $root.Path ("{0}_{1}.sql" -f $v, $slug)
  if (Test-Path $file) { Write-Host "Exists: $file -- skipping"; continue }

  $header = "-- Backfilled from cloud supabase_migrations.schema_migrations`n" +
            ("-- Version: {0}`n" -f $v) +
            ("-- Name: {0}`n" -f $name) +
            ("-- Generated: {0}`n`n" -f (Get-Date -Format s)) +
            "BEGIN;`n"

  $body = ""
  $stmts = $rec.statements
  if ($null -ne $stmts -and $stmts.Count -gt 0) {
    $joined = @()
    foreach ($s in $stmts) {
      if ($null -ne $s) {
        $trimmed = ([string]$s) -replace ';+\s*$',''
        $joined += $trimmed
      }
    }
    if ($joined.Count -gt 0) { $body = ($joined -join ";`n") + ";`n" } else { $body = "-- intentionally empty (repair/no-op)`n" }
  } else {
    $body = "-- intentionally empty (repair/no-op)`n"
  }

  $tail = "COMMIT;`n"
  $content = $header + $body + $tail
  [System.IO.File]::WriteAllText($file, $content, $utf8NoBom)
  $created++
  Write-Host "Created: $file" -ForegroundColor Green
}

Write-Host "Backfilled $created migration file(s)." -ForegroundColor Green

