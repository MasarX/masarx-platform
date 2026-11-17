const {
  parseEnabledFlag,
  resolveDeployEnvironmentName,
  isProductionTarget,
  assertMutationAllowed,
} = require('../../../scripts/utils/production-mutation-guard');

describe('production-mutation-guard', () => {
  test('parseEnabledFlag handles common truthy/falsy values', () => {
    expect(parseEnabledFlag('enabled')).toBe(true);
    expect(parseEnabledFlag('1')).toBe(true);
    expect(parseEnabledFlag('false')).toBe(false);
    expect(parseEnabledFlag('', true)).toBe(true);
  });

  test('resolveDeployEnvironmentName uses deploy ladder keys', () => {
    expect(resolveDeployEnvironmentName({ DEPLOY_ENV_NAME: 'db-stg' })).toBe('db-stg');
    expect(resolveDeployEnvironmentName({ GITHUB_ENVIRONMENT_NAME: 'landing-prod' })).toBe('landing-prod');
  });

  test('isProductionTarget detects PROD_DEPLOY_GUARD and prod suffix', () => {
    expect(isProductionTarget({ PROD_DEPLOY_GUARD: 'enabled' })).toBe(true);
    expect(isProductionTarget({ DEPLOY_ENV: 'db-prod' })).toBe(true);
    expect(isProductionTarget({ GITHUB_ENVIRONMENT_NAME: 'db-stg' })).toBe(false);
  });

  test('assertMutationAllowed blocks production by default', () => {
    expect(() =>
      assertMutationAllowed({
        env: { PROD_DEPLOY_GUARD: 'enabled' },
        operation: 'seed-test-data',
        allowProductionEnvVar: 'SEED_TEST_DATA_ALLOW_PRODUCTION',
      }),
    ).toThrow('SEED_TEST_DATA_ALLOW_PRODUCTION');
  });

  test('assertMutationAllowed permits production when explicit override is enabled', () => {
    expect(() =>
      assertMutationAllowed({
        env: {
          PROD_DEPLOY_GUARD: 'enabled',
          SEED_TEST_DATA_ALLOW_PRODUCTION: '1',
        },
        operation: 'seed-test-data',
        allowProductionEnvVar: 'SEED_TEST_DATA_ALLOW_PRODUCTION',
      }),
    ).not.toThrow();
  });

  test('assertMutationAllowed requires allowProductionEnvVar option', () => {
    expect(() =>
      assertMutationAllowed({
        env: { DEPLOY_ENV: 'db-stg' },
        operation: 'seed-test-data',
      }),
    ).toThrow('allowProductionEnvVar');
  });
});
