const {
  detectViolations,
  extractMigrationVersion,
  formatViolations,
  hasViolations,
  parseIsoDateMs,
  parseNameStatus,
  resolvePreGaOverrideStatus,
} = require('../../../scripts/ops/ci/migration-guards');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('migration-guards', () => {
  describe('extractMigrationVersion', () => {
    test('extracts 10-14 digit version prefixes from migration filenames', () => {
      expect(extractMigrationVersion('supabase/migrations/202602050101_add_thing.sql')).toBe('202602050101');
      expect(extractMigrationVersion('supabase/migrations/20260205010101_add-Thing.V1.sql')).toBe('20260205010101');
    });

    test('returns empty string for non-migrations or invalid names', () => {
      expect(extractMigrationVersion('')).toBe('');
      expect(extractMigrationVersion('supabase/migrations/not_a_migration.sql')).toBe('');
      expect(extractMigrationVersion('supabase/seed.sql')).toBe('');
    });
  });

  describe('parseNameStatus', () => {
    test('parses A/M/D and R entries', () => {
      const text = [
        'A\tsupabase/migrations/202602050101_add.sql',
        'M\tsupabase/migrations/202601010000_base.sql',
        'D\tsupabase/migrations/202601020000_deleted.sql',
        'R100\tsupabase/migrations/202601030000_old.sql\tsupabase/migrations/202601030000_new.sql',
        '',
      ].join('\n');

      expect(parseNameStatus(text)).toEqual([
        { status: 'A', path: 'supabase/migrations/202602050101_add.sql' },
        { status: 'M', path: 'supabase/migrations/202601010000_base.sql' },
        { status: 'D', path: 'supabase/migrations/202601020000_deleted.sql' },
        {
          status: 'R',
          oldPath: 'supabase/migrations/202601030000_old.sql',
          newPath: 'supabase/migrations/202601030000_new.sql',
        },
      ]);
    });
  });

  describe('detectViolations', () => {
    test('flags modifications/deletions/renames of base migrations', () => {
      const basePaths = new Set([
        'supabase/migrations/202601010000_base.sql',
        'supabase/migrations/202601020000_base.sql',
      ]);
      const baseByVersion = new Map([
        ['202601010000', 'supabase/migrations/202601010000_base.sql'],
        ['202601020000', 'supabase/migrations/202601020000_base.sql'],
      ]);

      const v = detectViolations({
        diffEntries: [
          { status: 'M', path: 'supabase/migrations/202601010000_base.sql' },
          { status: 'D', path: 'supabase/migrations/202601020000_base.sql' },
          {
            status: 'R',
            oldPath: 'supabase/migrations/202601010000_base.sql',
            newPath: 'supabase/migrations/202602020000_moved.sql',
          },
        ],
        basePaths,
        baseByVersion,
      });

      expect(v.modifiedBase).toEqual(['supabase/migrations/202601010000_base.sql']);
      expect(v.deletedBase).toEqual(['supabase/migrations/202601020000_base.sql']);
      expect(v.renamedBase).toEqual([
        {
          oldPath: 'supabase/migrations/202601010000_base.sql',
          newPath: 'supabase/migrations/202602020000_moved.sql',
        },
      ]);
      expect(v.versionCollisions).toEqual([]);
    });

    test('flags version collisions when adding new migration with existing version', () => {
      const basePaths = new Set(['supabase/migrations/202601010000_base.sql']);
      const baseByVersion = new Map([['202601010000', 'supabase/migrations/202601010000_base.sql']]);

      const v = detectViolations({
        diffEntries: [{ status: 'A', path: 'supabase/migrations/202601010000_collision.sql' }],
        basePaths,
        baseByVersion,
      });

      expect(v.versionCollisions).toEqual([
        {
          version: '202601010000',
          basePath: 'supabase/migrations/202601010000_base.sql',
          newPath: 'supabase/migrations/202601010000_collision.sql',
        },
      ]);
    });
  });

  describe('formatViolations / hasViolations', () => {
    test('formats helpful collision fix guidance', () => {
      const v = {
        modifiedBase: [],
        deletedBase: [],
        renamedBase: [],
        versionCollisions: [
          {
            version: '202601010000',
            basePath: 'supabase/migrations/202601010000_base.sql',
            newPath: 'supabase/migrations/202601010000_collision.sql',
          },
        ],
      };

      expect(hasViolations(v)).toBe(true);
      const text = formatViolations(v).join('\n');
      expect(text).toContain('Migration version collision');
      expect(text).toContain('202601010000');
      expect(text).toContain('Fix: rename the new migration timestamp prefix');
    });

    test('returns false for an empty violations object', () => {
      expect(
        hasViolations({ modifiedBase: [], deletedBase: [], renamedBase: [], versionCollisions: [] }),
      ).toBe(false);
    });
  });

  describe('parseIsoDateMs', () => {
    test('parses YYYY-MM-DD as end-of-day UTC', () => {
      const parsed = parseIsoDateMs('2026-02-25');
      expect(parsed).toBe(Date.parse('2026-02-25T23:59:59.999Z'));
    });

    test('returns null for blank/invalid values', () => {
      expect(parseIsoDateMs('')).toBeNull();
      expect(parseIsoDateMs('not-a-date')).toBeNull();
    });
  });

  describe('resolvePreGaOverrideStatus', () => {
    test('enables override only when requested and config is active/non-expired', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-guards-'));
      const cfg = path.join(tmp, 'pre-ga-rebaseline.json');
      fs.writeFileSync(
        cfg,
        JSON.stringify(
          {
            active: true,
            expires_on: '2099-12-31',
            approvers: ['synthetic-reviewer'],
          },
          null,
          2,
        ),
      );

      const status = resolvePreGaOverrideStatus({
        env: { MIGRATION_GUARDS_PRE_GA_OVERRIDE: '1' },
        configPath: cfg,
        nowMs: Date.parse('2026-02-22T00:00:00.000Z'),
      });
      expect(status.enabled).toBe(true);
      expect(status.reason).toBe('enabled');
    });

    test('fails closed when requested but config missing/inactive/expired', () => {
      const missing = resolvePreGaOverrideStatus({
        env: { MIGRATION_GUARDS_PRE_GA_OVERRIDE: '1' },
        configPath: path.join(os.tmpdir(), 'does-not-exist-pre-ga-rebaseline.json'),
        nowMs: Date.parse('2026-02-22T00:00:00.000Z'),
      });
      expect(missing.enabled).toBe(false);
      expect(missing.requested).toBe(true);

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-guards-'));
      const inactiveCfg = path.join(tmp, 'inactive.json');
      fs.writeFileSync(
        inactiveCfg,
        JSON.stringify({ active: false, expires_on: '2099-12-31' }, null, 2),
      );
      const inactive = resolvePreGaOverrideStatus({
        env: { MIGRATION_GUARDS_PRE_GA_OVERRIDE: '1' },
        configPath: inactiveCfg,
        nowMs: Date.parse('2026-02-22T00:00:00.000Z'),
      });
      expect(inactive.enabled).toBe(false);
      expect(inactive.reason).toBe('config_inactive');

      const expiredCfg = path.join(tmp, 'expired.json');
      fs.writeFileSync(
        expiredCfg,
        JSON.stringify({ active: true, expires_on: '2026-02-01' }, null, 2),
      );
      const expired = resolvePreGaOverrideStatus({
        env: { MIGRATION_GUARDS_PRE_GA_OVERRIDE: '1' },
        configPath: expiredCfg,
        nowMs: Date.parse('2026-02-22T00:00:00.000Z'),
      });
      expect(expired.enabled).toBe(false);
      expect(expired.reason).toContain('config_expired');
    });
  });
});
