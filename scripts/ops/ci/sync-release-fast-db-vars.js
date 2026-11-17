#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

const { spawnSync } = require('child_process');

const PUBLIC_RELEASE_FAST_DB_VARIABLES = Object.freeze([
  'SUPABASE_PROJECT_ID',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_ORG_ID',
  'SUPABASE_REGION',
  'SUPABASE_POOLER_HOST',
  'SUPABASE_POOLER_PORT',
  'SUPABASE_PREFER_MANAGEMENT_API_KEYS',
]);

const FORBIDDEN_SECRET_VARIABLES = Object.freeze([
  'DATABASE_URL',
  'DATABASE_URL_DIRECT',
  'LOADTEST_DATABASE_URL',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'WEBHOOK_DB_JWT',
  'API_CALLER_DB_JWT',
  'API_GATEWAY_DB_JWT',
  'LABEL_RENDERER_DB_JWT',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    repo: '',
    sourceEnv: 'db-stg',
    apply: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--repo' && argv[i + 1]) {
      out.repo = String(argv[++i] || '').trim();
    } else if ((arg === '--source-env' || arg === '--environment') && argv[i + 1]) {
      out.sourceEnv = String(argv[++i] || '').trim();
    } else if (arg === '--apply') {
      out.apply = true;
    }
  }

  return out;
}

function die(message) {
  console.error(`[release-fast-db-vars] ${message}`);
  process.exit(1);
}

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(stderr || stdout || `gh ${args.join(' ')} failed with exit ${result.status}`);
  }
  return String(result.stdout || '');
}

function resolveRepoSlug(explicitRepo = '') {
  if (explicitRepo) return explicitRepo;
  const url = runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  if (!url) throw new Error('Unable to resolve repository slug with gh repo view.');
  return url;
}

function readEnvironmentVariables({ repo, sourceEnv }) {
  const raw = runGh([
    'variable',
    'list',
    '--repo',
    repo,
    '--env',
    sourceEnv,
    '--json',
    'name,value',
  ]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected gh variable list output for environment ${sourceEnv}.`);
  }
  return parsed;
}

function buildDesiredVariables(records) {
  const byName = new Map();
  for (const record of records || []) {
    const name = String(record?.name || '').trim();
    const value = String(record?.value || '').trim();
    if (!name || !value) continue;
    byName.set(name, value);
  }

  const desired = new Map();
  for (const name of PUBLIC_RELEASE_FAST_DB_VARIABLES) {
    const value = byName.get(name);
    if (value) desired.set(name, value);
  }
  return desired;
}

function validateDesiredVariables(desired) {
  const missing = PUBLIC_RELEASE_FAST_DB_VARIABLES.filter((name) => !desired.has(name));
  if (missing.length) {
    throw new Error(`Missing required public DB variable(s) in source environment: ${missing.join(', ')}`);
  }

  const forbidden = FORBIDDEN_SECRET_VARIABLES.filter((name) => desired.has(name));
  if (forbidden.length) {
    throw new Error(`Refusing to sync secret-only variable(s) as repository variables: ${forbidden.join(', ')}`);
  }
}

function syncVariables({ repo, desired, apply }) {
  const names = Array.from(desired.keys()).sort();
  if (!apply) {
    console.log(`[release-fast-db-vars] Dry run: would sync ${names.length} repo variable(s): ${names.join(', ')}`);
    return;
  }

  for (const name of names) {
    runGh(['variable', 'set', name, '--repo', repo, '--body', desired.get(name)]);
    console.log(`[release-fast-db-vars] Synced ${name}`);
  }
  console.log(`[release-fast-db-vars] Synced ${names.length} repo variable(s).`);
}

function main() {
  const args = parseArgs();
  const repo = resolveRepoSlug(args.repo);
  const records = readEnvironmentVariables({ repo, sourceEnv: args.sourceEnv });
  const desired = buildDesiredVariables(records);
  validateDesiredVariables(desired);
  syncVariables({ repo, desired, apply: args.apply });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
}

module.exports = {
  PUBLIC_RELEASE_FAST_DB_VARIABLES,
  FORBIDDEN_SECRET_VARIABLES,
  parseArgs,
  buildDesiredVariables,
  validateDesiredVariables,
  syncVariables,
};
