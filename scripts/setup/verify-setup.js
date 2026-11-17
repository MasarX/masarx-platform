/**
 * Setup Verification Script
 * Task Group 10: Verify prerequisites for local development environment
 *
 * Checks:
 * - Docker Desktop installed and running
 * - Node.js installed
 * - Supabase CLI installed
 * - Database connectivity
 *
 * Usage:
 *   node scripts/verify-setup.js
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = One or more checks failed
 */

const { execSync } = require('child_process');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

// Load environment variables (honors ENV_FILE)
loadEnv();

const envFile = process.env.ENV_FILE || '';
const explicitMode = (process.env.VERIFY_TARGET || '').toLowerCase();
const isCloudMode =
  explicitMode === 'cloud' ||
  process.env.IS_CLOUD === 'true' ||
  /\.env\.cloud$/i.test(envFile);
const skipDockerChecks = isCloudMode || process.env.SKIP_DOCKER_VERIFY === '1';

/**
 * Print colored message
 */
function print(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Print section header
 */
function printHeader(title) {
  print('\n' + '='.repeat(70), 'cyan');
  print(title.toUpperCase(), 'cyan');
  print('='.repeat(70), 'cyan');
}

/**
 * Execute command and return output
 */
function runCommand(command, silent = false) {
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' });
    return { success: true, output: output.trim() };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Check if Docker Desktop is installed
 */
async function checkDockerInstalled() {
  print('\n[1/6] Checking Docker Desktop installation...', 'yellow');

  if (skipDockerChecks) {
    print('  - Skipping Docker Desktop installation check (cloud mode)', 'green');
    return true;
  }

  const result = runCommand('docker --version', true);

  if (result.success) {
    print(`  OK Docker Desktop installed: ${result.output}`, 'green');
    return true;
  } else {
    print('  FAIL Docker Desktop not found', 'red');
    print('    Install from: https://www.docker.com/products/docker-desktop', 'yellow');
    return false;
  }
}

/**
 * Check if Docker Desktop is running
 */
async function checkDockerRunning() {
  print('\n[2/6] Checking Docker Desktop status...', 'yellow');

  if (skipDockerChecks) {
    print('  - Skipping Docker Desktop status check (cloud mode)', 'green');
    return true;
  }

  const result = runCommand('docker ps', true);

  if (result.success) {
    print('  OK Docker Desktop is running', 'green');
    return true;
  } else {
    print('  FAIL Docker Desktop is not running', 'red');
    print('    Start Docker Desktop and try again', 'yellow');
    return false;
  }
}

/**
 * Check if Node.js is installed
 */
async function checkNodeInstalled() {
  print('\n[3/6] Checking Node.js installation...', 'yellow');

  const result = runCommand('node --version', true);

  if (result.success) {
    const version = result.output;
    const major = parseInt(version.replace('v', '').split('.')[0]);

    if (major >= 18) {
      print(`  OK Node.js installed: ${version} (>= 18.0.0)`, 'green');
      return true;
    } else {
      print(`  FAIL Node.js version ${version} is too old (requires >= 18.0.0)`, 'red');
      print('    Install from: https://nodejs.org', 'yellow');
      return false;
    }
  } else {
    print('  FAIL Node.js not found', 'red');
    print('    Install from: https://nodejs.org', 'yellow');
    return false;
  }
}

async function checkRequiredEnv() {
  print('\n[4/6] Checking required environment variables...', 'yellow');

  const missing = [];

  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const apiCallerJwt = process.env.API_CALLER_DB_JWT || '';
  const webhookDbJwt = process.env.WEBHOOK_DB_JWT || '';
  const labelRendererJwt = process.env.LABEL_RENDERER_DB_JWT || process.env.LABEL_RENDER_DB_JWT || '';

  const requireEnv = (key, description) => {
    if (!process.env[key] || process.env[key].trim().length === 0) {
      missing.push(`${key} (${description})`);
    }
  };

  requireEnv('SUPABASE_URL', 'Supabase project URL');
  requireEnv('DATABASE_URL', 'Postgres connection string');
  requireEnv('SUPABASE_PROJECT_ID', 'Supabase project reference');

  if (!serviceRole) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY (required for admin/ops automation)');
  }

  if (!anonKey) {
    missing.push('SUPABASE_ANON_KEY (required for edge DB JWT auth)');
  }

  if (!apiCallerJwt) {
    missing.push('API_CALLER_DB_JWT (required for api-caller edge RPC access)');
  }

  if (!webhookDbJwt) {
    missing.push('WEBHOOK_DB_JWT (required for webhook-receiver edge RPC access)');
  }

  if (!labelRendererJwt) {
    missing.push('LABEL_RENDERER_DB_JWT (required for label-renderer edge RPC access)');
  }

  if (missing.length === 0) {
    print('  Environment variables OK', 'green');
    return true;
  }

  print('  Missing environment variables:', 'red');
  missing.forEach((item) => print(`    - ${item}`, 'yellow'));
  return false;
}

/**
 * Check if Supabase CLI is installed
 */
async function checkSupabaseInstalled() {
  print('\n[5/6] Checking Supabase CLI availability...', 'yellow');

  const local = runCommand('supabase --version', true);

  if (local.success) {
    print(`  OK Supabase CLI available (global): ${local.output}`, 'green');
    return true;
  }

  // Cloud-first fallback: use npx with the repo-pinned CLI version (no global install).
  const pinnedVersion = String(process.env.SUPABASE_CLI_VERSION || '2').trim() || '2';
  const npxRes = runCommand(`npx --yes supabase@${pinnedVersion} --version`, true);
  if (npxRes.success) {
    print(`  OK Supabase CLI available (npx): ${npxRes.output}`, 'green');
    return true;
  }

  print('  FAIL Supabase CLI unavailable (global + npx fallback)', 'red');
  if (isCloudMode) {
    print('    Cloud-first workflows rely on npx being able to fetch the Supabase CLI.', 'yellow');
  }
  print('    Fix options:', 'yellow');
  print('      1. Ensure npx can fetch packages (network/proxy), or', 'yellow');
  print('      2. Install Supabase CLI globally: npm install -g supabase', 'yellow');
  print(`    Pinned version expected: SUPABASE_CLI_VERSION=${pinnedVersion}`, 'yellow');
  return false;
}

/**
 * Check database connectivity
 */
async function checkDatabaseConnectivity() {
  print('\n[6/6] Checking database connectivity...', 'yellow');

  if (!process.env.DATABASE_URL) { throw new Error('[verify-setup] DATABASE_URL is required.'); }
  const connectionString = process.env.DATABASE_URL;

  const pool = new Pool({ connectionString });

  try {
    const client = await pool.connect();

    try {
      // Test connection with simple query
      const result = await client.query('SELECT version()');
      const version = result.rows[0].version;

      print(`  OK Database connection successful`, 'green');
      print(`    PostgreSQL: ${version.split(',')[0]}`, 'green');

      // Check if PostGIS extension is available
      const extensionResult = await client.query(`
        SELECT extname FROM pg_extension WHERE extname = 'postgis'
      `);

      if (extensionResult.rows.length > 0) {
        print(`    PostGIS: Enabled`, 'green');
      }

      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    print('  FAIL Database connection failed', 'red');
    print(`    Error: ${error.message}`, 'red');
    print(`    Connection: ${connectionString.replace(/:[^:@]+@/, ':***@')}`, 'yellow');
    if (isCloudMode) {
      print('    Verify cloud DATABASE_URL credentials and network access.', 'yellow');
    } else {
      print('    Ensure Supabase is running: supabase start', 'yellow');
    }
    return false;
  } finally {
    await pool.end();
  }
}

/**
 * Main verification function
 */
async function main() {
  printHeader('MasarX Platform - Setup Verification');

  const checks = [
    { name: 'Docker Installed', fn: checkDockerInstalled },
    { name: 'Docker Running', fn: checkDockerRunning },
    { name: 'Node.js Installed', fn: checkNodeInstalled },
    { name: 'Required Environment Variables', fn: checkRequiredEnv },
    { name: 'Supabase CLI Installed', fn: checkSupabaseInstalled },
    { name: 'Database Connectivity', fn: checkDatabaseConnectivity }
  ];

  const results = [];

  // Run all checks
  for (const check of checks) {
    const passed = await check.fn();
    results.push({ name: check.name, passed });
  }

  // Summary
  printHeader('Verification Summary');

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;

  for (const result of results) {
    const icon = result.passed ? 'OK' : 'FAIL';
    const color = result.passed ? 'green' : 'red';
    print(`  ${icon} ${result.name}`, color);
  }

  print('');
  print('='.repeat(70), 'cyan');

  if (passedCount === totalCount) {
    print(`OK ALL CHECKS PASSED (${passedCount}/${totalCount})`, 'green');
    print('='.repeat(70), 'cyan');
    if (isCloudMode) {
      print('\nCloud environment verification succeeded.', 'green');
      print('\nNext steps:', 'cyan');
      print('  1. Dry-run migrations against cloud: npm run db:push:dry');
      print('  2. Run cloud verify: npm run verify:cloud:core');
      print('  3. Monitor Supabase logs for runtime issues.');
    } else {
      print('\nYour local environment is ready for development!', 'green');
      print('\nNext steps:', 'cyan');
      print('  1. Start Supabase: supabase start');
      print('  2. Run migrations: supabase db reset');
      print('  3. Seed test data: node scripts/data/seed-test-data.js 10000');
      print('  4. Run tests: npm test');
      print('  5. Open Studio UI: http://localhost:54323 -- objectives:allow LOCALHOST Justification: documentation hint for local Studio URL');
    }
    process.exit(0);
  } else {
    print(`FAIL SOME CHECKS FAILED (${passedCount}/${totalCount} passed)`, 'red');
    print('='.repeat(70), 'cyan');
    print('\nPlease resolve the failed checks above and try again.', 'red');
    process.exit(1);
  }
}

// Run verification
main().catch((error) => {
  console.error('\nFatal error during verification:', error);
  process.exit(1);
});



