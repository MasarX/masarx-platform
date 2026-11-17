const {
  assertProdFixtureMutationGuard,
  buildEnvironmentCommands,
  ensureApplyAllowed,
  isTruthyFlag,
  parseArgs,
  resolveExecutionDate,
  resolveTargetEnvironments,
  resolveVerificationProfile,
} = require('../../../scripts/ops/prega-reset-rollout');

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

describe('prega-reset-rollout', () => {
  test('parseArgs supports repeated env flags and apply toggle', () => {
    const parsed = parseArgs([
      '--env',
      'dev',
      '--env=stg',
      '--apply',
      '--allow-prod',
      '--date=2026-02-24',
    ]);
    expect(parsed.envs).toEqual(['dev', 'stg']);
    expect(parsed.apply).toBe(true);
    expect(parsed.allowProd).toBe(true);
    expect(parsed.date).toBe('2026-02-24');
  });

  test('resolveExecutionDate defaults to UTC date', () => {
    const date = resolveExecutionDate('', new Date('2026-02-24T11:00:00.000Z'));
    expect(date).toBe('2026-02-24');
  });

  test('resolveExecutionDate rejects invalid date strings', () => {
    expect(() => resolveExecutionDate('2026/02/24')).toThrow('Invalid --date value');
  });

  test('resolveTargetEnvironments requires allow-prod when prod is selected', () => {
    expect(() =>
      resolveTargetEnvironments({ envs: ['prod'], allowProd: false, all: false }),
    ).toThrow('Production rollout requires --allow-prod');
  });

  test('resolveTargetEnvironments honors --all order', () => {
    const envs = resolveTargetEnvironments({ all: true, allowProd: true, envs: [] });
    expect(envs).toEqual(['dev', 'stg', 'prod']);
  });

  test('buildEnvironmentCommands includes reset + verification commands by default', () => {
    const plan = buildEnvironmentCommands({
      envName: 'dev',
      date: '2026-02-24',
      backupOnly: false,
      skipReset: false,
      skipProvision: false,
      skipVerification: false,
      platform: 'linux',
    });

    expect(normalizePath(plan.evidenceDir)).toContain('docs/ops/evidence/2026-02-24/prega-reset/dev');
    const labels = plan.steps.map((step) => step.label);
    expect(labels).toEqual([
      'backup:schema',
      'backup:data',
      'reset',
      'db:push',
      'configure:edge-api-caller',
      'ensure:storage-buckets',
      'lint:db',
      'test:pgtap',
      'test:integration',
    ]);

    const pgtapStep = plan.steps.find((step) => step.label === 'test:pgtap');
    expect(pgtapStep.env).toEqual({ PGTAP_FILES_PER_SESSION: '25' });
  });

  test('buildEnvironmentCommands injects prod reset env guard', () => {
    const plan = buildEnvironmentCommands({
      envName: 'prod',
      date: '2026-02-24',
      backupOnly: false,
      skipReset: false,
      skipProvision: true,
      skipVerification: true,
      platform: 'linux',
    });
    const reset = plan.steps.find((step) => step.label === 'reset');
    expect(reset.env).toEqual({ SUPABASE_CLI_ALLOW_PRODUCTION_RESET: '1' });
  });

  test('buildEnvironmentCommands uses prod-safe verification profile for prod', () => {
    const plan = buildEnvironmentCommands({
      envName: 'prod',
      date: '2026-02-24',
      backupOnly: false,
      skipReset: true,
      skipProvision: true,
      skipVerification: false,
      platform: 'linux',
    });

    expect(plan.verificationProfile).toBe('prod-safe');
    expect(plan.steps.map((step) => step.label)).toEqual([
      'backup:schema',
      'backup:data',
      'db:push',
      'lint:db',
      'db:connect:smoke',
      'workflow-intake-smoke',
      'prod:data-hygiene:audit',
    ]);

    const fixtureEnvSteps = plan.steps.filter((step) =>
      step.env && Object.prototype.hasOwnProperty.call(step.env, 'TEST_FIXTURE_BOOTSTRAP_ALLOW_PRODUCTION'));
    expect(fixtureEnvSteps).toHaveLength(0);
  });

  test('buildEnvironmentCommands rejects prod full verification profile', () => {
    expect(() =>
      buildEnvironmentCommands({
        envName: 'prod',
        date: '2026-02-24',
        backupOnly: false,
        skipReset: true,
        skipProvision: true,
        skipVerification: false,
        verificationProfile: 'full',
        platform: 'linux',
      }),
    ).toThrow('Production rollout requires --verification-profile=prod-safe.');
  });

  test('assertProdFixtureMutationGuard blocks prod fixture bootstrap override env vars', () => {
    expect(() =>
      assertProdFixtureMutationGuard({
        envName: 'prod',
        env: {
          TEST_FIXTURE_BOOTSTRAP_ALLOW_PRODUCTION: '1',
        },
      }),
    ).toThrow('TEST_FIXTURE_BOOTSTRAP_ALLOW_PRODUCTION must be unset');

    expect(() =>
      assertProdFixtureMutationGuard({
        envName: 'prod',
        env: {
          INTEGRATION_SKIP_FIXTURE_BOOTSTRAP: '0',
        },
      }),
    ).toThrow('INTEGRATION_SKIP_FIXTURE_BOOTSTRAP=0 enables fixture bootstrap against prod.');

    expect(() =>
      assertProdFixtureMutationGuard({
        envName: 'prod',
        env: {
          PGTAP_SKIP_FIXTURE_BOOTSTRAP: '0',
        },
      }),
    ).toThrow('PGTAP_SKIP_FIXTURE_BOOTSTRAP=0 enables fixture bootstrap against prod.');
  });

  test('resolveVerificationProfile defaults by environment', () => {
    expect(resolveVerificationProfile({ envName: 'dev', requestedProfile: '' })).toBe('full');
    expect(resolveVerificationProfile({ envName: 'stg', requestedProfile: '' })).toBe('full');
    expect(resolveVerificationProfile({ envName: 'prod', requestedProfile: '' })).toBe('prod-safe');
  });

  test('ensureApplyAllowed blocks CI apply unless explicit override is set', () => {
    expect(() => ensureApplyAllowed(true, { CI: 'true' })).toThrow(
      'Refusing --apply in CI without SUPABASE_CLI_ALLOW_RESET_IN_CI=1.',
    );
  });

  test('ensureApplyAllowed permits CI apply when explicit override is enabled', () => {
    expect(() => ensureApplyAllowed(true, { CI: 'true', SUPABASE_CLI_ALLOW_RESET_IN_CI: '1' })).not.toThrow();
    expect(() => ensureApplyAllowed(true, { CI: 'true', SUPABASE_CLI_ALLOW_RESET_IN_CI: 'true' })).not.toThrow();
  });

  test('isTruthyFlag recognizes strict allow values only', () => {
    expect(isTruthyFlag('1')).toBe(true);
    expect(isTruthyFlag('true')).toBe(true);
    expect(isTruthyFlag('yes')).toBe(true);
    expect(isTruthyFlag('')).toBe(false);
    expect(isTruthyFlag('0')).toBe(false);
    expect(isTruthyFlag('false')).toBe(false);
  });
});
