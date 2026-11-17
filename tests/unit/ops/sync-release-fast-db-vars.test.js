const {
  PUBLIC_RELEASE_FAST_DB_VARIABLES,
  FORBIDDEN_SECRET_VARIABLES,
  buildDesiredVariables,
  validateDesiredVariables,
} = require('../../../scripts/ops/ci/sync-release-fast-db-vars');

describe('sync release-fast DB vars', () => {
  test('builds the repo variable map from the public environment allowlist only', () => {
    const records = [
      ...PUBLIC_RELEASE_FAST_DB_VARIABLES.map((name) => ({ name, value: `${name.toLowerCase()}-value` })),
      { name: 'SUPABASE_DB_PASSWORD', value: 'secret-password' },
      { name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'secret-service-role' },
      { name: 'IGNORED_OPTIONAL_VALUE', value: 'ignored' },
    ];

    const desired = buildDesiredVariables(records);

    expect(Array.from(desired.keys()).sort()).toEqual([...PUBLIC_RELEASE_FAST_DB_VARIABLES].sort());
    for (const forbidden of FORBIDDEN_SECRET_VARIABLES) {
      expect(desired.has(forbidden)).toBe(false);
    }
  });

  test('fails closed when a required public variable is missing', () => {
    const records = PUBLIC_RELEASE_FAST_DB_VARIABLES
      .filter((name) => name !== 'SUPABASE_PROJECT_ID')
      .map((name) => ({ name, value: `${name.toLowerCase()}-value` }));

    const desired = buildDesiredVariables(records);

    expect(() => validateDesiredVariables(desired)).toThrow(/SUPABASE_PROJECT_ID/);
  });
});
