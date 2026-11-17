const {
  resolveProvisionAutoPreviewFallbackOnStrictFailure,
  resolveProvisionFixJwtSecret,
  resolveProvisionPushRetryConfig,
  resolveProvisionRequireLeastPrivilege,
} = require('../../../scripts/ops/workspace/provision-utils');

describe('resolveProvisionFixJwtSecret', () => {
  test('returns false when EDGE_REQUIRE_DB_JWT != 1', () => {
    expect(
      resolveProvisionFixJwtSecret({
        argv: ['--fix-jwt-secret'],
        env: { WORKSPACE_FIX_JWT_SECRET: '1' },
        edgeRequireDbJwt: '0',
        projectWasCreated: true,
      })
    ).toBe(false);
  });

  test('returns true when project was created (workspace safe default)', () => {
    expect(
      resolveProvisionFixJwtSecret({
        argv: [],
        env: {},
        edgeRequireDbJwt: '1',
        projectWasCreated: true,
      })
    ).toBe(true);
  });

  test('returns true when --fix-jwt-secret flag is present', () => {
    expect(
      resolveProvisionFixJwtSecret({
        argv: ['--fix-jwt-secret'],
        env: {},
        edgeRequireDbJwt: '1',
        projectWasCreated: false,
      })
    ).toBe(true);
  });

  test('returns true when --rotate-jwt-secret alias is present', () => {
    expect(
      resolveProvisionFixJwtSecret({
        argv: ['--rotate-jwt-secret'],
        env: {},
        edgeRequireDbJwt: '1',
        projectWasCreated: false,
      })
    ).toBe(true);
  });

  test('returns true when positional fix-jwt-secret is present (npm flag stripping)', () => {
    expect(
      resolveProvisionFixJwtSecret({
        argv: ['fix-jwt-secret'],
        env: {},
        edgeRequireDbJwt: '1',
        projectWasCreated: false,
      })
    ).toBe(true);
  });

  test('returns true when npm_config_fix_jwt_secret is truthy', () => {
    expect(
      resolveProvisionFixJwtSecret({
        argv: [],
        env: { npm_config_fix_jwt_secret: '1' },
        edgeRequireDbJwt: '1',
        projectWasCreated: false,
      })
    ).toBe(true);
  });

  test('returns true when WORKSPACE_FIX_JWT_SECRET is truthy', () => {
    expect(
      resolveProvisionFixJwtSecret({
        argv: [],
        env: { WORKSPACE_FIX_JWT_SECRET: 'true' },
        edgeRequireDbJwt: '1',
        projectWasCreated: false,
      })
    ).toBe(true);
  });

  test('returns false by default', () => {
    expect(
      resolveProvisionFixJwtSecret({
        argv: [],
        env: {},
        edgeRequireDbJwt: '1',
        projectWasCreated: false,
      })
    ).toBe(false);
  });
});

describe('resolveProvisionRequireLeastPrivilege', () => {
  test('defaults to strict mode', () => {
    expect(resolveProvisionRequireLeastPrivilege({ env: {} })).toBe(true);
  });

  test('disables strict mode when preview fallback is explicitly allowed', () => {
    expect(
      resolveProvisionRequireLeastPrivilege({
        env: { WORKSPACE_ALLOW_PREVIEW_FALLBACK: '1' },
      })
    ).toBe(false);
  });

  test('disables strict mode when least-privilege requirement is explicitly off', () => {
    expect(
      resolveProvisionRequireLeastPrivilege({
        env: { WORKSPACE_REQUIRE_LEAST_PRIVILEGE: 'false' },
      })
    ).toBe(false);
  });
});

describe('resolveProvisionAutoPreviewFallbackOnStrictFailure', () => {
  test('defaults enabled for newly created projects', () => {
    expect(
      resolveProvisionAutoPreviewFallbackOnStrictFailure({
        env: {},
        projectWasCreated: true,
      })
    ).toBe(true);
  });

  test('defaults disabled when project was not created in this run', () => {
    expect(
      resolveProvisionAutoPreviewFallbackOnStrictFailure({
        env: {},
        projectWasCreated: false,
      })
    ).toBe(false);
  });

  test('supports explicit opt-out', () => {
    expect(
      resolveProvisionAutoPreviewFallbackOnStrictFailure({
        env: { WORKSPACE_AUTO_PREVIEW_FALLBACK_ON_STRICT_FAIL: '0' },
        projectWasCreated: true,
      })
    ).toBe(false);
  });
});

describe('resolveProvisionPushRetryConfig', () => {
  test('uses expanded retry defaults for newly created projects', () => {
    expect(
      resolveProvisionPushRetryConfig({
        env: {},
        projectWasCreated: true,
      })
    ).toEqual({
      attempts: '10',
      baseDelayMs: '20000',
      maxDelayMs: '180000',
    });
  });

  test('uses standard defaults for existing projects', () => {
    expect(
      resolveProvisionPushRetryConfig({
        env: {},
        projectWasCreated: false,
      })
    ).toEqual({
      attempts: '5',
      baseDelayMs: '15000',
      maxDelayMs: '120000',
    });
  });

  test('prefers explicit environment overrides', () => {
    expect(
      resolveProvisionPushRetryConfig({
        env: {
          SUPABASE_CLI_PUSH_RETRY_ATTEMPTS: '12',
          SUPABASE_CLI_PUSH_RETRY_BASE_DELAY_MS: '5000',
          SUPABASE_CLI_PUSH_RETRY_MAX_DELAY_MS: '90000',
        },
        projectWasCreated: true,
      })
    ).toEqual({
      attempts: '12',
      baseDelayMs: '5000',
      maxDelayMs: '90000',
    });
  });
});
