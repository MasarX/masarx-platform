#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const softFailFiles = new Set([
  '202510110001_extensions.sql',
  '202510150202_remove_uuid_ossp_extension.sql',
  '202510200002_label_generation_security.sql',
  '202510200028_label_render_assets_bucket.sql',
  '202510261345_storage_authenticated_restrict_policy.sql',
  '202511130007_storage_buckets_policies.sql',
  '202512271210_edge_label_renderer_storage_access.sql',
  '202512301535_label_designer_storage_assets_policies.sql',
  '202512301550_label_designer_storage_assets_policies_fixup.sql',
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

function discoverMigrationFiles(migrationsDir) {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort();
}

async function ensureMigrationHistoryTable(client, logger = console) {
  await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
  await client.query(`
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[] NOT NULL DEFAULT '{}',
      name text,
      inserted_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  logger.log('[migrate-local] Ensured local Supabase migration history table.');
}

async function recordMigration(client, file) {
  const version = versionFromFile(file);
  const name = nameFromFile(file);
  if (!version) {
    return;
  }

  try {
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version, statements, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name`,
      [version, [], name],
    );
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/supabase_migrations\.schema_migrations/i.test(message) && /does not exist/i.test(message)) {
      console.warn('[migrate-local] schema_migrations history table is missing; continuing without recording history.');
      return;
    }
    throw error;
  }
}

async function ensureLocalAuthJwtCompatibility(client, logger = console) {
  const result = await client.query(
    `SELECT to_regprocedure('auth.jwt()') IS NOT NULL AS exists`,
  );
  if (result.rows[0] && result.rows[0].exists) return;
  await client.query(`
    CREATE OR REPLACE FUNCTION auth.jwt()
    RETURNS jsonb
    LANGUAGE sql
    STABLE
    AS $$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
        jsonb_build_object('sub', NULLIF(current_setting('request.jwt.claim.sub', true), ''))
      );
    $$;
  `);
  logger.warn('[migrate-local] Created local auth.jwt() compatibility helper.');
}

async function handleSoftFailMigration(client, file, logger = console) {
  try {
    await client.query('ROLLBACK');
  } catch (_) {
    // Best-effort cleanup for migrations that did not open a transaction.
  }
  await recordMigration(client, file);
  logger.warn(
    `[migrate-local] Migration ${file} failed in local-only mode (soft-fail allowed); continuing.`,
  );
}

function isSoftFailMigration(file, error, softFails = softFailFiles) {
  if (softFails.has(file)) return true;
  const message = String(error && error.message ? error.message : error);
  const storagePolicyMigration = /storage/i.test(String(file || ''));
  return (
    storagePolicyMigration &&
    (/relation "storage\.objects" does not exist/i.test(message) ||
      /storage schema missing/i.test(message))
  );
}

async function applyPendingMigrations(client, options = {}) {
  const migrationsDir = options.migrationsDir || path.join(process.cwd(), 'supabase', 'migrations');
  const files = options.files || discoverMigrationFiles(migrationsDir);
  const softFails = options.softFailFiles || softFailFiles;
  const logger = options.logger || console;

  await ensureMigrationHistoryTable(client, logger);

  let applied = new Set();
  try {
    const rows = await client.query('select version from supabase_migrations.schema_migrations order by version');
    applied = new Set(rows.rows.map((row) => String(row.version || '').trim()).filter(Boolean));
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (!/does not exist/i.test(message)) {
      throw error;
    }
    logger.warn('[migrate-local] schema_migrations table missing; applying all migrations without history tracking.');
  }

  const pending = files.filter((file) => !applied.has(versionFromFile(file)));
  if (!pending.length) {
    logger.log('[migrate-local] No pending migrations detected, nothing to do.');
    return;
  }

  for (const file of pending) {
    const fullPath = path.join(migrationsDir, file);
    logger.log(`[migrate-local] Applying ${file}...`);
    const sql = fs.readFileSync(fullPath, 'utf8');
    try {
      await client.query(sql);
      await recordMigration(client, file);
    } catch (error) {
      if (isSoftFailMigration(file, error, softFails)) {
        await handleSoftFailMigration(client, file, logger);
        continue;
      }
      throw error;
    }
  }

  logger.log('[migrate-local] All migrations applied successfully.');
}

async function main() {
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

  const files = discoverMigrationFiles(migrationsDir);
  if (!files.length) {
    console.log('[migrate-local] No migrations discovered, nothing to do.');
    process.exit(0);
  }

  console.log('[migrate-local] Using DATABASE_URL:', dbUrl);

  const client = new Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 15000,
  });

  await client.connect();
  try {
    await ensureLocalAuthJwtCompatibility(client);
    await applyPendingMigrations(client, { files, migrationsDir });
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[migrate-local] Failed: ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  applyPendingMigrations,
  discoverMigrationFiles,
  ensureMigrationHistoryTable,
  ensureLocalAuthJwtCompatibility,
  handleSoftFailMigration,
  isSoftFailMigration,
  nameFromFile,
  recordMigration,
  softFailFiles,
  versionFromFile,
};
