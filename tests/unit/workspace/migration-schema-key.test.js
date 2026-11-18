const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIGRATION_SQL_NORMALIZATION_CONTRACT,
  buildMigrationSchemaKey,
  buildMigrationSqlNormalizationExpression,
  listMigrationFiles,
  normalizeMigrationSqlContent,
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

  test('sorts mixed timestamp widths lexically and updates when an untracked migration file appears', () => {
    writeMigration(tmpDir, '20260601000002_second.sql', 'select 2;\n');
    writeMigration(tmpDir, '20260601000001_first.sql', 'select 1;\n');
    writeMigration(tmpDir, '20251122111500_older_fourteen_digit.sql', 'select 0;\n');

    const before = buildMigrationSchemaKey(tmpDir);
    expect(listMigrationFiles(tmpDir).map((filePath) => path.basename(filePath))).toEqual([
      '20251122111500_older_fourteen_digit.sql',
      '20260601000001_first.sql',
      '20260601000002_second.sql',
    ]);
    expect(before.migration_head).toBe('20260601000002_second.sql');

    writeMigration(tmpDir, '202607201100_untracked_phase_delta.sql', 'select 3;\n');
    const after = buildMigrationSchemaKey(tmpDir);

    expect(after.schema_key).not.toBe(before.schema_key);
    expect(after.migration_head).toBe('202607201100_untracked_phase_delta.sql');
    expect(after.migration_count).toBe(4);
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

  test('uses the same BOM newline and edge-whitespace normalization as database content proof', () => {
    const name = '202607201300_normalized.sql';
    writeMigration(tmpDir, name, '\uFEFFselect 1;\r\n\r\n');
    const windows = buildMigrationSchemaKey(tmpDir);
    writeMigration(tmpDir, name, 'select 1;\n');
    const unix = buildMigrationSchemaKey(tmpDir);

    expect(normalizeMigrationSqlContent('\uFEFFselect 1;\r\n\r\n')).toBe('select 1;');
    expect(normalizeMigrationSqlContent('\u00A0select 1;\u00A0')).toBe('\u00A0select 1;\u00A0');
    expect(windows.schema_key).toBe(unix.schema_key);
    expect(windows.entries[0].sha256).toBe(unix.entries[0].sha256);
    expect(windows.entries[0].raw_sha256).not.toBe(unix.entries[0].raw_sha256);
    expect(MIGRATION_SQL_NORMALIZATION_CONTRACT).toBe('masarx-migration-sql-normalization.v1');
    expect(buildMigrationSqlNormalizationExpression('candidate.value')).toBe([
      'btrim(',
      'replace(replace(',
      'case when left(candidate.value, 1) = chr(65279) then substr(candidate.value, 2) else candidate.value end,',
      "E'\\r\\n', E'\\n'), E'\\r', E'\\n'),",
      "E' \\t\\n\\r\\f\\v')",
    ].join(' '));
    expect(() => buildMigrationSqlNormalizationExpression('candidate.value); drop table x; --'))
      .toThrow(/trusted SQL identifier/);
  });
});
