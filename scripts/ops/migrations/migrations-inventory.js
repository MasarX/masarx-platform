const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function attachPgClientErrorTrap(client, label) {
  if (!client || typeof client.on !== 'function') return;
  const context = String(label || 'pg-client').trim() || 'pg-client';
  client.on('error', (error) => {
    const message = error && error.message ? error.message : String(error);
    console.warn(`[migrations-inventory] ${context} emitted client error event: ${message}`);
  });
}

function normalizeMigrationBaseName(name) {
  if (!name) return '';
  let n = String(name).trim();
  n = n.replace(/\.sql$/i, '');
  n = n.replace(/^\d{8,}[_-]/, '');
  return n.trim();
}

function listLocalMigrations(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const dir = options.migrationsDir || path.join(rootDir, 'supabase', 'migrations');
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing supabase/migrations directory at ${dir}`);
  }

  const versions = new Set();
  const baseByVersion = new Map();

  const crawl = (p) => {
    const entries = fs.readdirSync(p, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        if (e.name === 'archive' || e.name.startsWith('.')) continue;
        crawl(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.toLowerCase().endsWith('.sql')) continue;
      const m = e.name.match(/^(\d{10,14})_([a-z0-9_-]+)\.sql$/i);
      if (!m) continue;
      const version = m[1];
      const base = m[2];
      versions.add(version);
      if (!baseByVersion.has(version)) baseByVersion.set(version, base);
    }
  };

  crawl(dir);
  return { versions, baseByVersion };
}

async function listRemoteMigrations(dbUrl, options = {}) {
  const connectionString = String(dbUrl || '').replace(/^['"]|['"]$/g, '').trim();
  if (!connectionString) {
    return { table: '', rows: [], missingHistory: true };
  }

  const config = { connectionString };
  const timeoutMs = Number.parseInt(String(options.connectionTimeoutMillis || ''), 10);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    config.connectionTimeoutMillis = timeoutMs;
  }

  const client = new Client(config);
  attachPgClientErrorTrap(client, 'listRemoteMigrations');
  await client.connect();
  try {
    let res;
    let table = '';
    try {
      res = await client.query('select version, name from supabase_migrations.schema_migrations order by version');
      table = 'schema_migrations';
    } catch (e1) {
      try {
        res = await client.query('select version, name from supabase_migrations.applied_migrations order by version');
        table = 'applied_migrations';
      } catch (e2) {
        const code = String(e2 && e2.code || '').trim();
        const msg = String(e2 && e2.message || '').toLowerCase();
        if (code === '42p01' || msg.includes('does not exist')) {
          return { table: '', rows: [], missingHistory: true };
        }
        throw e2;
      }
    }

    const rows = (res && res.rows ? res.rows : [])
      .map((r) => ({
        version: String(r.version || '').trim(),
        name: String(r.name || '').trim(),
      }))
      .filter((r) => Boolean(r.version));

    return { table, rows, missingHistory: false };
  } finally {
    try {
      await client.end();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn(`[migrations-inventory] listRemoteMigrations client shutdown warning: ${message}`);
    }
  }
}

function computeMigrationDiff({ local, remoteRows }) {
  const localVersions = local && local.versions ? local.versions : new Set();
  const baseByVersion = local && local.baseByVersion ? local.baseByVersion : new Map();

  const remote = Array.isArray(remoteRows) ? remoteRows : [];
  const remoteByVersion = new Map();
  for (const r of remote) {
    const version = String(r && r.version || '').trim();
    if (!version) continue;
    const name = String(r && r.name || '').trim();
    const base = normalizeMigrationBaseName(name);
    remoteByVersion.set(version, { version, name, base });
  }

  const missingLocalInRemote = Array.from(localVersions).filter((v) => !remoteByVersion.has(v)).sort();

  const remoteOnly = [];
  const nameMismatches = [];
  for (const [version, row] of remoteByVersion.entries()) {
    if (!localVersions.has(version)) remoteOnly.push(version);
    const localBase = baseByVersion.get(version) || '';
    const remoteBase = String(row.base || '').trim();
    if (localBase && remoteBase && localBase.toLowerCase() !== remoteBase.toLowerCase()) {
      nameMismatches.push({
        version,
        localBase,
        remoteBase,
        remoteNameRaw: row.name,
      });
    }
  }

  remoteOnly.sort();
  nameMismatches.sort((a, b) => a.version.localeCompare(b.version));

  const ok =
    missingLocalInRemote.length === 0 &&
    remoteOnly.length === 0 &&
    nameMismatches.length === 0;

  return { ok, missingLocalInRemote, remoteOnly, nameMismatches };
}

module.exports = {
  normalizeMigrationBaseName,
  listLocalMigrations,
  listRemoteMigrations,
  computeMigrationDiff,
};
