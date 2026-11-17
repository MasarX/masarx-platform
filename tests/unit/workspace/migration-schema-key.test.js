const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildMigrationSchemaKey,
  listMigrationFiles,
} = require('../../../scripts/ops/workspace/migration-schema-key');

function writeMigration(root, name, sql) {
  const dir = path.join(root, 'supabase', 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), sql, 'utf8');
}

describe('migration schema key', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-schema-key-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns a stable compact key for empty migration directories', () => {
    const summary = buildMigrationSchemaKey(tmpDir);

    expect(summary).toMatchObject({
      schema_key: expect.stringMatching(/^supabase-migrations:/),
      migration_head: 'none',
      migration_count: 0,
      source: 'supabase-migrations-content-sha256',
    });
    expect(summary.entries).toEqual([]);
  });

  test('sorts migration files and updates when an untracked migration file appears', () => {
    writeMigration(tmpDir, '20260601000002_second.sql', 'select 2;\n');
    writeMigration(tmpDir, '20260601000001_first.sql', 'select 1;\n');

    const before = buildMigrationSchemaKey(tmpDir);
    expect(listMigrationFiles(tmpDir).map((filePath) => path.basename(filePath))).toEqual([
      '20260601000001_first.sql',
      '20260601000002_second.sql',
    ]);
    expect(before.migration_head).toBe('20260601000002_second.sql');

    writeMigration(tmpDir, '20260601000003_untracked_phase_delta.sql', 'select 3;\n');
    const after = buildMigrationSchemaKey(tmpDir);

    expect(after.schema_key).not.toBe(before.schema_key);
    expect(after.migration_head).toBe('20260601000003_untracked_phase_delta.sql');
    expect(after.migration_count).toBe(3);
  });

  test('hashes a large local migration set within a bounded time', () => {
    for (let index = 0; index < 400; index += 1) {
      writeMigration(
        tmpDir,
        `20260601${String(index).padStart(4, '0')}_large_${index}.sql`,
        `select ${index};\n-- ${'x'.repeat(200)}\n`,
      );
    }

    const started = Date.now();
    const summary = buildMigrationSchemaKey(tmpDir);
    const elapsedMs = Date.now() - started;

    expect(summary.migration_count).toBe(400);
    expect(summary.schema_key).toMatch(/^supabase-migrations:/);
    expect(elapsedMs).toBeLessThan(1500);
  });
});
