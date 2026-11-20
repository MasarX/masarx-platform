#!/usr/bin/env node
/**
 * Debug helper: prints a safe summary of the DB target and Supabase project
 * for the current process environment. Intended for CI logs so we can verify
 * which database a workflow is using without leaking credentials.
 */

/* eslint-disable no-console */
const crypto = require('crypto');
const { loadEnv } = require('../utils/load-env');
const { hashUrlTarget } = require('../utils/hash-url-target');

function projectLabel(value) {
  if (!value) return '';
  const h = crypto.createHash('sha256').update(String(value)).digest('hex');
  return `${h.slice(0, 12)}…`; // short, non-reversible fingerprint
}

function urlLabel(value) {
  const label = hashUrlTarget(value);
  return label ? label + '…' : '';
}

function parsePostgresDsn(dsn) {
  if (!dsn) return {};
  try {
    // Strip quotes if present
    let v = String(dsn).replace(/^['"]|['"]$/g, '');
    // Basic postgres DSN: postgres(ql)://user:pass@host:port/db?params
    const schemeMatch = v.match(/^(postgres(ql)?:\/\/)(.*)$/i);
    if (schemeMatch) {
      v = schemeMatch[3];
    }
    const atIdx = v.indexOf('@');
    if (atIdx >= 0) {
      v = v.slice(atIdx + 1); // drop userinfo
    }
    const slashIdx = v.indexOf('/');
    const hostPort = slashIdx >= 0 ? v.slice(0, slashIdx) : v;
    const dbAndQuery = slashIdx >= 0 ? v.slice(slashIdx + 1) : '';
    const [host, port] = hostPort.split(':');
    const dbName = dbAndQuery.split(/[?;]/)[0];
    return {
      host: host || '',
      port: port || '',
      database: dbName || '',
    };
  } catch {
    return {};
  }
}

function main() {
  // Respect ENV_FILE and existing env resolution
  try {
    loadEnv();
  } catch {
    // Best-effort; if loadEnv fails we still try with process.env
  }

  const {
    SUPABASE_PROJECT_ID,
    SUPABASE_URL,
    SUPABASE_REGION,
    SUPABASE_POOLER_HOST,
    SUPABASE_POOLER_PORT,
    DATABASE_URL,
    DATABASE_URL_DIRECT,
  } = process.env;

  const direct = parsePostgresDsn(DATABASE_URL_DIRECT || DATABASE_URL || '');
  const pooler = parsePostgresDsn(DATABASE_URL || '');

  console.log('[db-debug] Supabase project');
  console.log(`  project_id: ${SUPABASE_PROJECT_ID || '<unset>'}`);
  console.log(`  project_hash: ${projectLabel(SUPABASE_PROJECT_ID || '')}`);
  console.log(`  region:     ${SUPABASE_REGION || '<unset>'}`);
  let urlHost = '<unset>';
  if (SUPABASE_URL) {
    try {
      const stripped = SUPABASE_URL.replace(/^https?:\/\//i, '');
      urlHost = stripped.split('/')[0];
    } catch {
      urlHost = SUPABASE_URL;
    }
  }
  console.log(`  url_host:   ${urlHost}`);
  console.log(`  url_hash:   ${urlLabel(SUPABASE_URL)}`);

  console.log('[db-debug] Direct DATABASE_URL snapshot');
  console.log(`  host:       ${direct.host || '<unset>'}`);
  console.log(`  port:       ${direct.port || '<unset>'}`);
  console.log(`  database:   ${direct.database || '<unset>'}`);
  console.log(`  hash:       ${urlLabel(DATABASE_URL_DIRECT || DATABASE_URL)}`);

  console.log('[db-debug] Pooler / CI DATABASE_URL snapshot');
  console.log(`  host:       ${SUPABASE_POOLER_HOST || pooler.host || '<unset>'}`);
  console.log(`  port:       ${SUPABASE_POOLER_PORT || pooler.port || '<unset>'}`);
  console.log(`  database:   ${pooler.database || '<unset>'}`);
  console.log(`  hash:       ${urlLabel(DATABASE_URL)}`);
}

main();
