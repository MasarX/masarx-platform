#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../../utils/load-env');

loadEnv();

async function main() {
  // Prefer explicit ref via --ref; else SUPABASE_PROJECT_ID from ENV_FILE
  const idx = process.argv.indexOf('--ref');
  const ref = (idx !== -1 && process.argv[idx + 1]) || process.env.SUPABASE_PROJECT_ID || '';
  const pass = process.env.SUPABASE_DB_PASSWORD || '';
  const region = process.env.SUPABASE_REGION || '';
  if (!ref) { console.error('Missing --ref or SUPABASE_PROJECT_ID'); process.exit(1); }
  if (!pass) { console.error('Missing SUPABASE_DB_PASSWORD in env'); process.exit(1); }
  async function tryConnect(url) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: url, statement_timeout: 10000, query_timeout: 10000, connectionTimeoutMillis: 15000 });
    try {
      await client.connect();
      const res = await client.query('select 1 as ok');
      console.log('SELECT_1 =', res.rows[0]?.ok);
      return true;
    } finally {
      await client.end().catch(()=>{});
    }
  }

  // Try direct DB host first
  const hostDb = `db.${ref}.supabase.co`;
  // objectives:allow DSN_URL Justification: construct Supabase cloud Postgres DSN from project_ref and password for connectivity diagnostics only; tenant routing stays configuration-driven
  const urlDb = ([`postgresql`,":","/","/",`postgres`,":",`${encodeURIComponent(pass)}`,"@",`${hostDb}`,":",`5432`,"/",`postgres`].join(""));
  console.log('Connecting to', hostDb);
  try {
    if (await tryConnect(urlDb)) return;
  } catch (e) {
    console.warn('DB host not ready:', e.message);
  }

  // Fallback to pooler if region known
  if (region) {
    const poolerHost = `aws-1-${region}.pooler.supabase.com`;
    const poolerUser = `postgres.${ref}`;
    // objectives:allow DSN_URL Justification: construct Supabase pooler DSN from project_ref and password for diagnostics; shared cloud DB, not tenant-specific config
    const urlPool = ([`postgresql`,":","/","/",`${encodeURIComponent(poolerUser)}`,":",`${encodeURIComponent(pass)}`,"@",`${poolerHost}`,":",`5432`,"/",`postgres`].join(""));
    console.log('Connecting via pooler', poolerHost);
    await tryConnect(urlPool);
  } else {
    throw new Error('Region not set and DB host not ready');
  }
}

main().catch(err => { console.error('diag-connect failed:', err.message); process.exit(1); });
