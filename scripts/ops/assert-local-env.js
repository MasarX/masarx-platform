#!/usr/bin/env node
/* eslint-disable no-console */
// objectives:allow LOCALHOST Justification: guard ensures DATABASE_URL is local-only for dev tooling; no tenant- or client-specific routing
// Asserts that every database URL inherited by local tooling points to a local endpoint.
const { loadEnv } = require('../utils/load-env');

loadEnv();

function parsePgHost(dsn) {
  const m = (dsn || '').match(/^[a-z]+:\/\/[^@]+@([^/:?#]+)(?::\d+)?\//i);
  return m ? m[1] : '';
}

const DB_URL_KEYS = [
  'DATABASE_URL',
  'DATABASE_URL_DIRECT',
  'ONLINE_INDEX_DATABASE_URL',
  'SUPABASE_DB_URL',
  'POSTGRES_URL',
];

function assertLocalDatabaseUrls(env = process.env) {
  const dbUrl = (env.DATABASE_URL || '').trim();
  if (!dbUrl) throw new Error('Missing DATABASE_URL');
  for (const key of DB_URL_KEYS) {
    const value = String(env[key] || '').trim();
    if (!value) continue;
    const host = parsePgHost(value);
    if (!host) throw new Error(`Could not parse ${key} host`);
    // objectives:allow LOCALHOST Justification: enforce local-only database URLs for safety checks
    if (!['localhost', '127.0.0.1'].includes(host)) {
      throw new Error(`${key} must be local; got host=${host}`);
    }
  }
}

function main() {
  try {
    assertLocalDatabaseUrls(process.env);
  } catch (error) {
    console.error(`[assert-local-env] ${error.message}`);
    process.exit(1);
  }
  console.log('[assert-local-env] Local environment validated');
}

if (require.main === module) main();

module.exports = { assertLocalDatabaseUrls, parsePgHost };
