param(
  [string]$EnvFile = ""
)

$ErrorActionPreference = 'Stop'

function Get-DbUrlFromFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "ENV file not found: $path"
  }
  $line = Get-Content -LiteralPath $path | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  if (-not $line) { throw "DATABASE_URL not found in $path" }
  $val = ($line -replace '^DATABASE_URL=','').Trim('"')
  return $val
}

$resolvedEnvFile = if ($EnvFile) {
  $EnvFile
} elseif ($env:ENV_FILE) {
  $env:ENV_FILE
} else {
  "config/env/.env.cloud"
}

$dburl = if ($env:DATABASE_URL) {
  $env:DATABASE_URL
} else {
  Get-DbUrlFromFile -path $resolvedEnvFile
}
Write-Host "Running db diff for" $dburl

New-Item -ItemType Directory -Force -Path 'tmp' | Out-Null

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = "/c npx -y supabase@2 db diff --db-url `"$dburl`" --schema public --use-migra -f tmp\\cloud_recon_raw.sql --yes"
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.WorkingDirectory = (Get-Location).Path

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$null = $proc.Start()

while (-not $proc.HasExited) {
  Start-Sleep -Seconds 5
}

if ($proc.ExitCode -ne 0) {
  Write-Host "db diff exited with" $proc.ExitCode
  exit $proc.ExitCode
}

if (Test-Path 'tmp/cloud_recon_raw.sql') {
  $len = (Get-Item 'tmp/cloud_recon_raw.sql').Length
  Write-Host "db diff completed; tmp/cloud_recon_raw.sql size=" $len
} else {
  Write-Host "db diff completed; no diff file created"
}
