#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const dbUrl = (process.env.DATABASE_URL || '').trim();
if (!dbUrl) {
  console.error('[migrate-local] DATABASE_URL is not set. Ensure ENV_FILE points to .env.local.<env_id>.');
  process.exit(1);
}

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
if (!fs.existsSync(migrationsDir)) {
  console.error(`[migrate-local] Migrations directory not found: ${migrationsDir}`);
  process.exit(1);
}

const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.toLowerCase().endsWith('.sql'))
  .sort();

if (!files.length) {
  console.log('[migrate-local] No migrations discovered, nothing to do.');
  process.exit(0);
}

const softFailFiles = new Set([
  '202510110001_extensions.sql',
  '202510150202_remove_uuid_ossp_extension.sql',
  '202510200002_label_generation_security.sql',
  '202510200028_label_render_assets_bucket.sql',
  '202510261345_storage_authenticated_restrict_policy.sql',
  '202511130007_storage_buckets_policies.sql',
]);

function versionFromFile(file) {
  const match = String(file || '').match(/^([0-9]+)/);
  return match ? match[1] : '';
}

function nameFromFile(file) {
  return String(file || '')
    .replace(/^([0-9]+)_/, '')
    .replace(/\.sql$/i, '');
}

async function recordMigration(client, file, sourceSql) {
  const version = versionFromFile(file);
  const name = nameFromFile(file);
  if (!version) {
    return;
  }

  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations(version, statements, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name`,
    [version, [String(sourceSql || '')], name],
  );
}

async function main() {
  console.log('[migrate-local] Using configured database connection.');

  const client = new Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 15000,
  });

  await client.connect();
  try {
    const rows = await client.query('select version from supabase_migrations.schema_migrations order by version');
    const applied = new Set(rows.rows.map((row) => String(row.version || '').trim()).filter(Boolean));

    const pending = files.filter((file) => !applied.has(versionFromFile(file)));
    if (!pending.length) {
      console.log('[migrate-local] No pending migrations detected, nothing to do.');
      return;
    }

    for (const file of pending) {
      const fullPath = path.join(migrationsDir, file);
      console.log(`[migrate-local] Applying ${file}...`);
      const sql = fs.readFileSync(fullPath, 'utf8');
      try {
        await client.query(sql);
      } catch (error) {
        if (softFailFiles.has(file)) {
          await client.query('ROLLBACK');
          console.warn(
            `[migrate-local] Migration ${file} failed in local-only mode (soft-fail allowed); continuing.`,
          );
          continue;
        }
        throw error;
      }
      await recordMigration(client, file, sql);
    }

    console.log('[migrate-local] All migrations applied successfully.');
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[migrate-local] Failed: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
