param(
  [string]$EnvFile = "",
  [switch]$IncludeAll
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

function Redact-DbUrl([string]$url) {
  if (-not $url) { return $url }
  return ($url -replace '^(postgres(?:ql)?://[^:]+):[^@]+@', '$1:***@')
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

Write-Host "Pushing migrations to" (Redact-DbUrl -url $dburl)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$args = "/c npx -y supabase@2 db push --db-url `"$dburl`" --yes"
if ($IncludeAll) { $args = $args + " --include-all" }
$psi.Arguments = $args
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $false
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError = $false
$psi.WorkingDirectory = (Get-Location).Path

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$null = $proc.Start()
$proc.WaitForExit()
exit $proc.ExitCode
