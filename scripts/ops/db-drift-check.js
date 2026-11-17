#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * db-drift-check.js
 *
 * Lightweight drift detector between:
 *   - Remote parent project (mhln) migrations
 *   - Repo migrations under supabase/migrations/
 *
 * Strategy:
 *   - Treat repo as SSOT for names.
 *   - Compare migration *names* only (no heavy Docker/migra).
 *   - Exit 0 when in sync; 1 when drift exists, printing JSON summary.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');

function listRepoMigrations() {
  const dir = path.join(process.cwd(), 'supabase', 'migrations');
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing supabase/migrations directory at ${dir}`);
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const baseNames = new Set();
  const fileByBase = {};
  const versionsByBase = {};
  const allVersions = new Set();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    if (!name.toLowerCase().endsWith('.sql')) continue;
    if (name.startsWith('.')) continue;
    const withoutExt = name.replace(/\.sql$/i, '');
    const m = withoutExt.match(/^(\d{8,})_(.+)$/);
    const version = m ? m[1] : null;
    const base = m ? m[2] : withoutExt;
    baseNames.add(base);
    if (!fileByBase[base]) fileByBase[base] = [];
    fileByBase[base].push(name);
    if (version) {
      allVersions.add(version);
      if (!versionsByBase[base]) versionsByBase[base] = [];
      versionsByBase[base].push(version);
    }
  }
  return { baseNames, fileByBase, versionsByBase, allVersions };
}

function normalizeBase(name) {
  if (!name) return '';
  let n = String(name);
  n = n.replace(/\.sql$/i, '');
  n = n.replace(/^\d{8,}_/, '');
  return n;
}

async function listRemoteMigrations(dbUrl) {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    let res;
    try {
      res = await client.query('select version, name from supabase_migrations.schema_migrations order by version');
    } catch (_) {
      res = await client.query('select version, name from supabase_migrations.applied_migrations order by version');
    }
    const names = new Set();
    const versions = new Set();
    for (const row of res.rows) {
      if (row.name) names.add(normalizeBase(row.name));
      if (row.version) versions.add(String(row.version));
    }
    return { baseNames: names, versions };
  } finally {
    await client.end();
  }
}

(async () => {
  loadEnv();
  let dbUrl = process.env.DATABASE_URL || '';
  dbUrl = dbUrl.replace(/^['"]|['"]$/g, '');
  if (!dbUrl) {
    console.error('[db-drift-check] DATABASE_URL is not set (expected parent env via ENV_FILE=config/env/.env.cloud)');
    process.exit(2);
  }

  const { baseNames: repoNames, fileByBase, versionsByBase } = listRepoMigrations();
  const { baseNames: remoteNames, versions: remoteVersions } = await listRemoteMigrations(dbUrl);

  const parentOnly = [...remoteNames].filter((n) => !repoNames.has(n)).sort();
  const repoOnly = [];
  for (const base of repoNames) {
    if (remoteNames.has(base)) continue;
    const vs = versionsByBase[base] || [];
    const hasVersionMatch = vs.some((v) => remoteVersions.has(v));
    if (!hasVersionMatch) repoOnly.push(base);
  }
  repoOnly.sort();

  // Hard-aligned when both directions match
  const ok = parentOnly.length === 0 && repoOnly.length === 0;
  const summary = { ok, parentOnly, repoOnly, fileByBase };

  console.log(JSON.stringify(summary, null, 2));
  if (!ok) {
    console.error('[db-drift-check] Drift detected between parent and repo migrations.');
    process.exit(1);
  }
  console.log('[db-drift-check] No drift detected (names in sync).');
  process.exit(0);
})().catch((err) => {
  console.error('[db-drift-check] Failed:', err.message);
  process.exit(1);
});
