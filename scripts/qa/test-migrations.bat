@echo off
REM Migration Testing Script for Windows
REM Run this after starting Docker Desktop

echo ================================
echo Migration Testing Script
echo ================================
echo.

set "SUPABASE_CMD=npx -y supabase@2"

REM Check Docker is running
echo Step 1: Checking Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker Desktop is not running
    echo Please start Docker Desktop and try again.
    pause
    exit /b 1
)
echo [OK] Docker Desktop is running
echo.

REM Reset database and apply all migrations
echo Step 2: Resetting database and applying migrations...
echo This will:
echo   - Drop all existing tables
echo   - Apply all 10 migrations sequentially
echo   - Insert 100+ seed records
echo.
set /p CONTINUE="Continue? (y/n): "
if /i not "%CONTINUE%"=="y" (
    echo Aborted.
    exit /b 0
)

echo Running supabase db reset...
%SUPABASE_CMD% db reset
if errorlevel 1 (
    echo [ERROR] Database reset failed
    echo Check errors above for details.
    pause
    exit /b 1
)
echo [OK] Database reset successful
echo.

REM Run pgTAP tests
echo Step 3: Running pgTAP tests...
%SUPABASE_CMD% test db
if errorlevel 1 (
    echo [ERROR] Some pgTAP tests failed
    echo Review test output above for details.
    pause
    exit /b 1
)
echo [OK] All pgTAP tests passed
echo.

REM Open Supabase Studio
echo Step 4: Opening Supabase Studio...
echo Studio URL: http://localhost:54323
echo.
echo Verify in Studio:
echo   - Table Editor shows all 66+ tables
echo   - Database ^> Functions shows partition management functions
echo   - Authentication ^> Policies shows 9 RLS policies
echo.
set /p OPEN_STUDIO="Open Supabase Studio in browser? (y/n): "
if /i "%OPEN_STUDIO%"=="y" (
    start http://localhost:54323
)
echo.

REM Summary
echo ================================
echo Testing Summary
echo ================================
echo [OK] Migration reset: PASSED
echo [OK] pgTAP tests: PASSED
echo.
echo Next steps:
echo   1. Review Supabase Studio (http://localhost:54323)
echo   2. Run integration tests: npm test (when available)
echo   3. Update tasks.md to mark Phase 5 complete
echo.
echo All tests passed! Migrations are production-ready.
echo.
pause
