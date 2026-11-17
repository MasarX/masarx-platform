const { shouldIncludeAllMigrations } = require('../../scripts/ops/supabase-cli-include-all');

describe('supabase-cli shouldIncludeAllMigrations', () => {
  test('defaults to false outside CI/preview', () => {
    expect(shouldIncludeAllMigrations({})).toBe(false);
  });

  test('respects explicit SUPABASE_DB_PUSH_INCLUDE_ALL=1', () => {
    expect(shouldIncludeAllMigrations({ SUPABASE_DB_PUSH_INCLUDE_ALL: '1' })).toBe(true);
    expect(shouldIncludeAllMigrations({ SUPABASE_DB_PUSH_INCLUDE_ALL: '0' })).toBe(false);
  });

  test('allows explicit disable override in CI/preview contexts', () => {
    expect(
      shouldIncludeAllMigrations({
        SUPABASE_DB_PUSH_INCLUDE_ALL: '0',
        GITHUB_ACTIONS: 'true',
        PREVIEW_MODE: '1',
      }),
    ).toBe(false);
    expect(
      shouldIncludeAllMigrations({
        SUPABASE_DB_PUSH_INCLUDE_ALL: 'false',
        CI: 'true',
      }),
    ).toBe(false);
  });

  test('enables include-all for preview environments', () => {
    expect(shouldIncludeAllMigrations({ PREVIEW_MODE: '1' })).toBe(true);
    expect(shouldIncludeAllMigrations({ PREVIEW_PROJECT_REF: 'wk-abc' })).toBe(true);
  });

  test('enables include-all for CI environments', () => {
    expect(shouldIncludeAllMigrations({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(shouldIncludeAllMigrations({ CI: 'true' })).toBe(true);
  });
});
