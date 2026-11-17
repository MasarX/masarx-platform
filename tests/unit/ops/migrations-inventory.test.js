const {
  computeMigrationDiff,
  normalizeMigrationBaseName,
} = require('../../../scripts/ops/migrations/migrations-inventory');

describe('ops/migrations-inventory', () => {
  test('normalizeMigrationBaseName strips version prefix and .sql', () => {
    expect(normalizeMigrationBaseName('202512261930_qa_ssot.sql')).toBe('qa_ssot');
    expect(normalizeMigrationBaseName('202512261930-qa_ssot.sql')).toBe('qa_ssot');
    expect(normalizeMigrationBaseName('qa_ssot.sql')).toBe('qa_ssot');
  });

  test('computeMigrationDiff returns ok when inventories match', () => {
    const local = {
      versions: new Set(['202510110001', '202512261930']),
      baseByVersion: new Map([
        ['202510110001', 'extensions'],
        ['202512261930', 'qa_ssot'],
      ]),
    };
    const remoteRows = [
      { version: '202510110001', name: '202510110001_extensions.sql' },
      { version: '202512261930', name: '202512261930_qa_ssot.sql' },
    ];
    const diff = computeMigrationDiff({ local, remoteRows });
    expect(diff.ok).toBe(true);
    expect(diff.missingLocalInRemote).toEqual([]);
    expect(diff.remoteOnly).toEqual([]);
    expect(diff.nameMismatches).toEqual([]);
  });

  test('computeMigrationDiff detects remote-only + name mismatches', () => {
    const local = {
      versions: new Set(['202510110001']),
      baseByVersion: new Map([['202510110001', 'extensions']]),
    };
    const remoteRows = [
      { version: '202510110001', name: '202510110001_ext.sql' },
      { version: '202501010000', name: '202501010000_old.sql' },
    ];
    const diff = computeMigrationDiff({ local, remoteRows });
    expect(diff.ok).toBe(false);
    expect(diff.missingLocalInRemote).toEqual([]);
    expect(diff.remoteOnly).toEqual(['202501010000']);
    expect(diff.nameMismatches.map((m) => m.version)).toEqual(['202510110001']);
  });
});

