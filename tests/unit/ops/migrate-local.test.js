const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyPendingMigrations,
  ensureLocalAuthJwtCompatibility,
  ensureMigrationHistoryTable,
  isSoftFailMigration,
  softFailFiles,
  versionFromFile,
  nameFromFile,
} = require('../../../scripts/ops/migrate-local');

describe('migrate-local', () => {
  test('parses migration version and name from filenames', () => {
    expect(versionFromFile('202510110001_extensions.sql')).toBe('202510110001');
    expect(nameFromFile('202510110001_extensions.sql')).toBe('extensions');
  });

  test('treats local-only storage grants as soft-fail migrations', () => {
    expect(softFailFiles.has('202512271210_edge_label_renderer_storage_access.sql')).toBe(true);
    expect(softFailFiles.has('202512301535_label_designer_storage_assets_policies.sql')).toBe(true);
    expect(softFailFiles.has('202512301550_label_designer_storage_assets_policies_fixup.sql')).toBe(true);
    expect(
      isSoftFailMigration(
        '202601011200_label_designer_storage_assets_policy_owner_relax.sql',
        new Error('relation "storage.objects" does not exist'),
      ),
    ).toBe(true);
    expect(
      isSoftFailMigration(
        '202601011200_label_designer_storage_assets_policy_owner_relax.sql',
        new Error('some other migration failure'),
      ),
    ).toBe(false);
  });

  test('soft-failed migrations rollback before recording local history', async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-local-soft-fail-'));
    const file = '202510110001_extensions.sql';
    fs.writeFileSync(path.join(migrationsDir, file), 'select fails;', 'utf8');

    const calls = [];
    const client = {
      async query(sql, params) {
        if (/select version from supabase_migrations\.schema_migrations/i.test(sql)) {
          calls.push('history');
          return { rows: [] };
        }
        if (/CREATE SCHEMA IF NOT EXISTS supabase_migrations/i.test(sql)) {
          calls.push('ensure-schema');
          return { rows: [] };
        }
        if (/CREATE TABLE IF NOT EXISTS supabase_migrations\.schema_migrations/i.test(sql)) {
          calls.push('ensure-history');
          return { rows: [] };
        }
        if (sql === 'select fails;') {
          calls.push('migration');
          throw new Error('extension not available locally');
        }
        if (sql === 'ROLLBACK') {
          calls.push('rollback');
          return { rows: [] };
        }
        if (/INSERT INTO supabase_migrations\.schema_migrations/i.test(sql)) {
          calls.push(`record:${params[0]}:${params[2]}`);
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const logger = { log: jest.fn(), warn: jest.fn() };

    await applyPendingMigrations(client, { files: [file], migrationsDir, logger });

    expect(calls).toEqual([
      'ensure-schema',
      'ensure-history',
      'history',
      'migration',
      'rollback',
      'record:202510110001:extensions',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      '[migrate-local] Migration 202510110001_extensions.sql failed in local-only mode (soft-fail allowed); continuing.',
    );
    expect(logger.log).toHaveBeenLastCalledWith('[migrate-local] All migrations applied successfully.');
  });

  test('ensures local migration history table before applying migrations', async () => {
    const calls = [];
    const client = {
      async query(sql) {
        if (/CREATE SCHEMA IF NOT EXISTS supabase_migrations/i.test(sql)) {
          calls.push('schema');
          return { rows: [] };
        }
        if (/CREATE TABLE IF NOT EXISTS supabase_migrations\.schema_migrations/i.test(sql)) {
          calls.push('table');
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const logger = { log: jest.fn() };

    await ensureMigrationHistoryTable(client, logger);

    expect(calls).toEqual(['schema', 'table']);
    expect(logger.log).toHaveBeenCalledWith(
      '[migrate-local] Ensured local Supabase migration history table.',
    );
  });

  test('creates auth.jwt compatibility helper when the local stack lacks it', async () => {
    const calls = [];
    const client = {
      async query(sql) {
        if (/to_regprocedure\('auth\.jwt\(\)'\)/i.test(sql)) {
          calls.push('probe');
          return { rows: [{ exists: false }] };
        }
        if (/CREATE OR REPLACE FUNCTION auth\.jwt\(\)/i.test(sql)) {
          calls.push('create');
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const logger = { warn: jest.fn() };

    await ensureLocalAuthJwtCompatibility(client, logger);

    expect(calls).toEqual(['probe', 'create']);
    expect(logger.warn).toHaveBeenCalledWith(
      '[migrate-local] Created local auth.jwt() compatibility helper.',
    );
  });
});
