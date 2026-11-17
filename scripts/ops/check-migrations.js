#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

function listLocalMigrations() {
  const dir = path.join(process.cwd(), 'supabase', 'migrations');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name);
  const parsed = [];
  for (const f of files) {
    const m = f.match(/^(\d{12})_(.+)\.sql$/);
    if (!m) continue;
    parsed.push({ version: m[1], name: m[2], file: f });
  }
  parsed.sort((a, b) => a.version.localeCompare(b.version));
  return parsed;
}

async function listRemoteMigrations(pool) {
  const sql = `
    SELECT version::text AS version, name
    FROM supabase_migrations.schema_migrations
    ORDER BY version`;
  const { rows } = await pool.query(sql);
  return rows.map((r) => ({ version: String(r.version), name: r.name }));
}

async function main() {
  loadEnv();
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    console.error('[check-migrations] DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    const local = listLocalMigrations();
    let remote;
    try {
      remote = await listRemoteMigrations(client);
    } catch (e) {
      console.error('[check-migrations] Failed to read supabase_migrations.schema_migrations:', e.message);
      process.exit(2);
    }
    const remoteKey = new Set(remote.map((r) => `${r.version}_${r.name}`));
    const localKey = new Set(local.map((l) => `${l.version}_${l.name}`));

    const pending = local.filter((l) => !remoteKey.has(`${l.version}_${l.name}`));
    const drift = remote.filter((r) => !localKey.has(`${r.version}_${r.name}`));

    console.log(JSON.stringify({
      summary: {
        local_count: local.length,
        remote_count: remote.length,
        pending_count: pending.length,
        drift_count: drift.length
      },
      pending,
      drift
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('[check-migrations] error:', e.message); process.exit(1); });
