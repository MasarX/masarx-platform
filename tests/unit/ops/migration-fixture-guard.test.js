const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectFixtureMarkersInText,
  isActiveMigrationPath,
  listAllActiveMigrations,
  resolveScanMode,
  scanChangedMigrations,
} = require('../../../scripts/ops/ci/migration-fixture-guard');

describe('migration-fixture-guard', () => {
  test('isActiveMigrationPath excludes archive and non-migration files', () => {
    expect(isActiveMigrationPath('supabase/migrations/202602220900_new.sql')).toBe(true);
    expect(isActiveMigrationPath('supabase/migrations/archive/pre-ga-fixtures/202602220900_new.sql')).toBe(
      false,
    );
    expect(isActiveMigrationPath('supabase/tests/pgtap/001_test.sql')).toBe(false);
  });

  test('detectFixtureMarkersInText flags known fixture markers', () => {
    const body = `
      -- canonical test fixture
      INSERT INTO webhook_sources (auth_token) VALUES ('test-token-basic');
      INSERT INTO clients (slug) VALUES ('test-client-2-1');
      INSERT INTO organizations (slug) VALUES ('automation-qa-org');
    `;
    const issues = detectFixtureMarkersInText(body);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes('automation-qa-org'))).toBe(true);
  });

  test('scanChangedMigrations reports file-level issues', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-fixture-guard-'));
    const filePath = path.join(tmp, '202602220930_fixture.sql');
    fs.writeFileSync(
      filePath,
      "INSERT INTO webhook_sources (auth_token) VALUES ('client-b-ack-token');\n",
      'utf8',
    );

    const findings = scanChangedMigrations([filePath]);
    expect(findings.length).toBe(1);
    expect(findings[0].filePath).toBe(filePath);
    expect(findings[0].issues.some((issue) => issue.toLowerCase().includes('fixture'))).toBe(true);
  });

  test('resolveScanMode supports changed/full modes', () => {
    expect(resolveScanMode({})).toBe('changed');
    expect(resolveScanMode({ MIGRATION_FIXTURE_GUARD_MODE: 'full' })).toBe('full');
    expect(resolveScanMode({ MIGRATION_FIXTURE_GUARD_FULL_CHAIN: '1' })).toBe('full');
    expect(() => resolveScanMode({ MIGRATION_FIXTURE_GUARD_MODE: 'invalid' })).toThrow(
      'Unsupported MIGRATION_FIXTURE_GUARD_MODE',
    );
  });

  test('listAllActiveMigrations excludes archive files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-fixture-all-'));
    const root = path.join(tmp, 'supabase', 'migrations');
    fs.mkdirSync(path.join(root, 'archive', 'pre-ga-fixtures'), { recursive: true });
    fs.writeFileSync(path.join(root, '202602220930_active.sql'), 'select 1;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'archive', 'pre-ga-fixtures', '202602220931_archived.sql'), 'select 1;\n', 'utf8');

    const files = listAllActiveMigrations({ rootDir: root });
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('supabase/migrations/202602220930_active.sql');
  });
});
