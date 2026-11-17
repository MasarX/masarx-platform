param(
    [Parameter(ParameterSetName = "Command", Mandatory = $true)]
    [string]$Command,

    [Parameter(ParameterSetName = "File", Mandatory = $true)]
    [string]$File,

    [Parameter()]
    [string]$OutFile,

    [Parameter()]
    [string]$EnvFile = ""
)

function Resolve-RepoRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StartDir
    )

    $cursor = Resolve-Path -Path $StartDir
    while ($true) {
        if (Test-Path (Join-Path $cursor "package.json")) { return $cursor }
        if (Test-Path (Join-Path $cursor ".git")) { return $cursor }

        $parent = Split-Path -Path $cursor -Parent
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
        $cursor = $parent
    }

    throw "Unable to resolve repository root from '$StartDir'"
}

$repoRoot = Resolve-RepoRoot -StartDir $PSScriptRoot
$defaultEnvFilePath = Join-Path -Path $repoRoot -ChildPath "config\\env\\.env.cloud"
$envFilePath = if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile
} elseif (-not [string]::IsNullOrWhiteSpace($Env:ENV_FILE)) {
    $Env:ENV_FILE
} else {
    $defaultEnvFilePath
}

if ([string]::IsNullOrWhiteSpace($Env:DATABASE_URL)) {
    if (-not (Test-Path $envFilePath)) {
        throw "DATABASE_URL is not set and environment file was not found at $envFilePath"
    }

    $envContent = Get-Content $envFilePath
    foreach ($line in $envContent) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("#")) { continue }
        $parts = $line -split "=", 2
        if ($parts.Length -lt 2) { continue }
        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if ($value.StartsWith([char]34) -and $value.EndsWith([char]34)) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

if ([string]::IsNullOrWhiteSpace($Env:DATABASE_URL)) {
    throw "DATABASE_URL is not set. Provide it directly or via -EnvFile/ENV_FILE."
}

switch ($PSCmdlet.ParameterSetName) {
    "File"     { $psqlArgs = @("-f", $File) }
    "Command"  { $psqlArgs = @("-c", $Command) }
    default    { throw "Unsupported parameter set '$($PSCmdlet.ParameterSetName)'" }
}

if ($OutFile) {
    & psql $Env:DATABASE_URL @psqlArgs | Tee-Object -FilePath $OutFile
} else {
    & psql $Env:DATABASE_URL @psqlArgs
}

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
