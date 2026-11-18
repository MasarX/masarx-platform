#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv } = require('../../utils/load-env');
const { resolveDatabaseUrlWithFallback } = require('../../utils/resolve-db-url');
const {
  evaluateOperatorAccounts,
  normalizeRequiredAccount: normalizeCoreAccount,
  resolveEnvironmentName,
} = require('./operator-access-core');

const VALID_ENVIRONMENTS = ['dev', 'stg', 'prod'];
const DEFAULT_CONFIG_TEMPLATE = path.join('config', 'ops', 'operator-accounts.%s.json');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    environment: '',
    config: '',
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--json') out.json = true;
    else if (token === '--environment') out.environment = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--environment=')) out.environment = token.split('=').slice(1).join('=').trim();
    else if (token === '--config') out.config = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--config=')) out.config = token.split('=').slice(1).join('=').trim();
  }
  return out;
}

function resolveConfigPath(environment, configArg = '') {
  const explicit = String(configArg || '').trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit);
  const inferred = DEFAULT_CONFIG_TEMPLATE.replace('%s', environment);
  return path.join(process.cwd(), inferred);
}

function readConfig(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeRequiredAccount(entry = {}) {
  return {
    ...normalizeCoreAccount(entry),
    status: 'active',
    require_wildcard_capability: String(entry.user_type || '').trim().toLowerCase() === 'super_admin',
  };
}

function ensureEnvironment(environment) {
  if (!VALID_ENVIRONMENTS.includes(environment)) {
    throw new Error(`Unsupported environment "${environment}". Expected one of: ${VALID_ENVIRONMENTS.join(', ')}`);
  }
}

function printUsage() {
  console.log('Usage: node scripts/ops/audit/operator-access-audit.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --environment <dev|stg|prod>  Target environment (default: inferred from env)');
  console.log('  --config <path>               Config path (default: config/ops/operator-accounts.<env>.json)');
  console.log('  --json                        Print JSON output');
  console.log('  --help, -h                    Show usage');
}

async function resolveDatabaseUrl() {
  const resolution = await resolveDatabaseUrlWithFallback({
    env: process.env,
    logger: console,
    label: 'operator-access-audit',
    connectionTimeoutEnv: 'OPERATOR_ACCESS_AUDIT_DB_CONNECT_TIMEOUT_MS',
    maxWaitEnv: 'OPERATOR_ACCESS_AUDIT_DB_CONNECT_MAX_WAIT_MS',
    retryDelayEnv: 'OPERATOR_ACCESS_AUDIT_DB_CONNECT_RETRY_DELAY_MS',
  });
  return resolution;
}

async function runAudit(options = {}) {
  const environment = String(options.environment || '').trim().toLowerCase();
  ensureEnvironment(environment);

  const configPath = resolveConfigPath(environment, options.configPath);
  const config = readConfig(configPath);
  const requiredAccounts = (Array.isArray(config.accounts) ? config.accounts : [])
    .map(normalizeRequiredAccount)
    .filter((entry) => entry.enabled);

  const dbResolution = await resolveDatabaseUrl();
  const client = new Client({ connectionString: dbResolution.dsn });
  await client.connect();
  try {
    const result = await evaluateOperatorAccounts(client, {
      requiredAccounts,
    });
    return {
      environment,
      config_path: configPath,
      db_candidate: dbResolution.candidateName,
      db_attempts: dbResolution.attempts,
      ...result,
    };
  } finally {
    await client.end();
  }
}

async function main() {
  try {
    loadEnv();
  } catch {
    // best-effort only; DB and config checks fail closed below
  }

  const args = parseArgs();
  if (args.help) {
    printUsage();
    return;
  }

  const environment = resolveEnvironmentName({
    explicitEnvironment: args.environment,
    env: process.env,
  });
  ensureEnvironment(environment);

  const result = await runAudit({
    environment,
    configPath: args.config,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('[operator-access-audit] Summary');
    console.log(`- environment: ${result.environment}`);
    console.log(`- config: ${path.relative(process.cwd(), result.config_path)}`);
    console.log(`- required_accounts: ${result.required}`);
    console.log(`- matched_accounts: ${result.findings.length}`);
    console.log(`- issues: ${result.issues.length}`);
  }

  if (!result.ok) {
    console.error('[operator-access-audit] FAILED');
    for (const issue of result.issues) {
      console.error(`  - ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('[operator-access-audit] OK');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[operator-access-audit] ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveConfigPath,
  runAudit,
};

