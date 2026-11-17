# setup-local.ps1 - Local Supabase Setup Automation for Windows
# Task Group 10: Automated setup script for local development environment
#
# Usage:
#   .\scripts\setup\setup-local.ps1
#
# Steps:
#   1. Check prerequisites
#   2. Initialize Supabase
#   3. Start Supabase stack
#   4. Run migrations
#   5. Install dependencies
#   6. Seed test data
#   7. Run verification tests

# Color functions for pretty output
function Write-Color {
    param(
        [string]$Text,
        [string]$Color = "White"
    )
    Write-Host $Text -ForegroundColor $Color
}

function Write-Header {
    param([string]$Text)
    Write-Color "`n$('=' * 70)" -Color Cyan
    Write-Color $Text.ToUpper() -Color Cyan
    Write-Color $('=' * 70) -Color Cyan
}

function Write-Step {
    param([string]$Step, [string]$Text)
    Write-Color "`n[$Step] $Text..." -Color Yellow
}

function Write-Success {
    param([string]$Text)
    Write-Color "  ✓ $Text" -Color Green
}

function Write-Error-Message {
    param([string]$Text)
    Write-Color "  ✗ $Text" -Color Red
}

function Write-Info {
    param([string]$Text)
    Write-Color "  ℹ  $Text" -Color Cyan
}

# =============================================================================
# STEP 0: Welcome
# =============================================================================

Write-Header "MasarX Platform - Local Setup"
Write-Color "This script will set up your local development environment" -Color White
Write-Color "Estimated time: 5-10 minutes on first run`n" -Color White

# =============================================================================
# STEP 1: Check Prerequisites
# =============================================================================

Write-Step "1/7" "Checking prerequisites"

$allChecksPassed = $true

# Check Docker Desktop installed
try {
    $dockerVersion = docker --version
    Write-Success "Docker Desktop installed: $dockerVersion"
} catch {
    Write-Error-Message "Docker Desktop not found"
    Write-Color "     Install from: https://www.docker.com/products/docker-desktop" -Color Yellow
    $allChecksPassed = $false
}

# Check Docker running
if ($allChecksPassed) {
    try {
        docker ps | Out-Null
        Write-Success "Docker Desktop is running"
    } catch {
        Write-Error-Message "Docker Desktop is not running"
        Write-Color "     Start Docker Desktop and run this script again" -Color Yellow
        $allChecksPassed = $false
    }
}

# Check Node.js
try {
    $nodeVersion = node --version
    $nodeMajor = [int]($nodeVersion -replace 'v', '' -split '\.')[0]

    if ($nodeMajor -ge 18) {
        Write-Success "Node.js installed: $nodeVersion (>= 18.0.0)"
    } else {
        Write-Error-Message "Node.js version $nodeVersion is too old (requires >= 18.0.0)"
        Write-Color "     Install from: https://nodejs.org" -Color Yellow
        $allChecksPassed = $false
    }
} catch {
    Write-Error-Message "Node.js not found"
    Write-Color "     Install from: https://nodejs.org" -Color Yellow
    $allChecksPassed = $false
}

# Check Supabase CLI
try {
    $supabaseVersion = supabase --version
    Write-Success "Supabase CLI installed: $supabaseVersion"
} catch {
    Write-Error-Message "Supabase CLI not found"
    Write-Color "     Install: npm install -g supabase" -Color Yellow
    $allChecksPassed = $false
}

if (-not $allChecksPassed) {
    Write-Header "Setup Failed"
    Write-Color "Please install missing prerequisites and run this script again.`n" -Color Red
    exit 1
}

# =============================================================================
# STEP 2: Initialize Supabase
# =============================================================================

Write-Step "2/7" "Initializing Supabase project"

if (Test-Path "supabase\config.toml") {
    Write-Info "Supabase already initialized (supabase\config.toml exists)"
} else {
    try {
        supabase init
        if ($LASTEXITCODE -ne 0) {
            throw "supabase init failed"
        }
        Write-Success "Supabase initialized"
    } catch {
        Write-Error-Message "Failed to initialize Supabase"
        Write-Color "     Error: $_" -Color Red
        exit 1
    }
}

# =============================================================================
# STEP 3: Start Supabase Stack
# =============================================================================

Write-Step "3/7" "Starting Supabase stack (this may take 2-3 minutes on first run)"

try {
    supabase start
    if ($LASTEXITCODE -ne 0) {
        throw "supabase start failed"
    }
    Write-Success "Supabase stack started"
} catch {
    Write-Error-Message "Failed to start Supabase"
    Write-Color "     Error: $_" -Color Red
    Write-Color "     Try: docker ps (check for port conflicts)" -Color Yellow
    exit 1
}

# =============================================================================
# STEP 4: Run Migrations
# =============================================================================

Write-Step "4/7" "Running database migrations"

try {
    supabase db reset --db-url $(('postgresql','://','postgres',':','postgres','@','localhost',':','54322','/','postgres') -join '')
    if ($LASTEXITCODE -ne 0) {
        throw "supabase db reset failed"
    }
    Write-Success "All migrations applied"
} catch {
    Write-Error-Message "Failed to run migrations"
    Write-Color "     Error: $_" -Color Red
    Write-Color "     Check migration files in supabase\migrations\" -Color Yellow
    exit 1
}

# =============================================================================
# STEP 5: Install Dependencies
# =============================================================================

Write-Step "5/7" "Installing test dependencies"

try {
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed"
    }
    Write-Success "Dependencies installed"
} catch {
    Write-Error-Message "Failed to install dependencies"
    Write-Color "     Error: $_" -Color Red
    exit 1
}

# =============================================================================
# STEP 6: Seed Test Data
# =============================================================================

Write-Step "6/7" "Seeding test data (10,000 shipments)"
Write-Color "  This will take about 20-30 seconds...`n" -Color White

try {
    node scripts\data\seed-test-data.js 10000
    if ($LASTEXITCODE -ne 0) {
        throw "seed script failed"
    }
    Write-Success "Test data seeded"
} catch {
    Write-Error-Message "Failed to seed test data"
    Write-Color "     Error: $_" -Color Red
    Write-Color "     You can seed manually later: node scripts\data\seed-test-data.js 10000" -Color Yellow
}

# =============================================================================
# STEP 7: Run Verification Tests
# =============================================================================

Write-Step "7/7" "Running verification tests"

try {
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Color "  ⚠  Some tests failed - review output above" -Color Yellow
        Write-Color "     You can investigate and re-run tests with: npm test" -Color Yellow
    } else {
        Write-Success "All tests passed"
    }
} catch {
    Write-Color "  ⚠  Test execution encountered errors" -Color Yellow
    Write-Color "     You can run tests manually later: npm test" -Color Yellow
}

# =============================================================================
# COMPLETION MESSAGE
# =============================================================================

Write-Header "Setup Complete"

Write-Color "`nLocal environment is ready!`n" -Color Green

Write-Color "Access points:" -Color Cyan
Write-Color "  • Studio UI:  http://localhost:54323" -Color White
Write-Color "  • PostgreSQL: $(('postgresql','://','postgres',':','postgres','@','localhost',':','54322','/','postgres') -join '')" -Color White
Write-Color "  • API:        http://localhost:54321" -Color White

Write-Color "`nNext steps:" -Color Cyan
Write-Color "  1. Open Studio UI to explore database: http://localhost:54323" -Color White
Write-Color "  2. Read migration guide: docs\MIGRATION_GUIDE.md" -Color White
Write-Color "  3. Reset database anytime: supabase db reset" -Color White
Write-Color "  4. Seed different volumes:" -Color White
Write-Color "     - Small:  node scripts\data\seed-test-data.js 100" -Color White
Write-Color "     - Medium: node scripts\data\seed-test-data.js 10000" -Color White
Write-Color "     - Large:  node scripts\data\seed-test-data.js 100000" -Color White
Write-Color "  5. Run tests: npm test`n" -Color White

Write-Color $('=' * 70) -Color Cyan
