const { loadDeploySurfaceRegistry, compileRegistry } = require('../../../scripts/ops/ci/deploy-surface-registry');
const {
  normalizeMode,
  buildEnvPolicyMap,
  compileExtraKeyPolicy,
  resolveEnvExtraKeyAllowances,
  compileUnmanagedEnvironmentPolicy,
  isUnmanagedEnvironmentAllowed,
  collectEnvironmentCatalogViolations,
} = require('../../../scripts/ops/ci/env-isolation-lint');

describe('env-isolation-lint', () => {
  test('normalizeMode maps common inputs', () => {
    expect(normalizeMode('')).toBe('warn');
    expect(normalizeMode('warn')).toBe('warn');
    expect(normalizeMode('enforce')).toBe('enforce');
    expect(normalizeMode('off')).toBe('off');
  });

  test('buildEnvPolicyMap includes deploy and approval environments', () => {
    const { registry } = loadDeploySurfaceRegistry({});
    const compiled = compileRegistry(registry);
    const map = buildEnvPolicyMap(compiled);

    expect(map.has('db-dev')).toBe(true);
    expect(map.has('stg-approval')).toBe(false);
    expect(map.has('prod-approval-db')).toBe(true);

    const approval = map.get('prod-approval-db');
    expect(approval.allowedSecretsRaw).toEqual([]);
    expect(approval.allowedVarsRaw).toEqual([]);
  });

  test('collectEnvironmentCatalogViolations reports unexpected unmanaged envs while honoring allowlist', () => {
    const unmanaged = compileUnmanagedEnvironmentPolicy({
      allow_unmanaged_environment_names: ['Preview'],
      allow_unmanaged_environment_name_patterns: ['^tmp-qa-'],
      allow_legacy_environment_alias_names: ['db-staging'],
    });

    expect(isUnmanagedEnvironmentAllowed('Preview', unmanaged)).toBe(true);
    expect(isUnmanagedEnvironmentAllowed('tmp-qa-123', unmanaged)).toBe(true);
    expect(isUnmanagedEnvironmentAllowed('github-pages', unmanaged)).toBe(false);

    const violations = collectEnvironmentCatalogViolations({
      expectedEnvs: ['db-dev', 'db-stg'],
      actualEnvs: ['db-dev', 'db-staging', 'Preview', 'tmp-qa-123', 'github-pages'],
      unmanagedPolicy: unmanaged,
      includeUnmanaged: true,
    });

    expect(violations).toEqual([
      { env: 'db-stg', kind: 'missing_environment' },
      { env: 'github-pages', kind: 'unexpected_unmanaged_environment' },
    ]);
  });

  test('compileExtraKeyPolicy resolves env-specific and pattern-based key allowances', () => {
    const policy = compileExtraKeyPolicy({
      allow_extra_keys_by_environment: {
        'portal-dev': { secrets: ['PREVIEW_SUPABASE_ACCESS_TOKEN'], vars: [] },
      },
      allow_extra_keys_by_environment_patterns: [
        { env_name_pattern: '^db-(dev|stg)$', vars: ['SUPABASE_PREFER_MANAGEMENT_API_KEYS'], secrets: [] },
      ],
    });

    const portalDev = resolveEnvExtraKeyAllowances('portal-dev', policy);
    expect(portalDev.secretsRaw).toEqual(['PREVIEW_SUPABASE_ACCESS_TOKEN']);
    expect(portalDev.varsRaw).toEqual([]);

    const dbDev = resolveEnvExtraKeyAllowances('db-dev', policy);
    expect(dbDev.varsRaw).toEqual(['SUPABASE_PREFER_MANAGEMENT_API_KEYS']);
    expect(dbDev.secretsRaw).toEqual([]);
  });

  test('buildEnvPolicyMap merges extra key policy into surface allowlists per env', () => {
    const { registry } = loadDeploySurfaceRegistry({});
    const compiled = compileRegistry(registry);
    const extraKeyPolicy = compileExtraKeyPolicy({
      allow_extra_keys_by_environment_patterns: [
        { env_name_pattern: '^db-dev$', vars: ['VERIFY_CORE_ALLOW_EXTENDED_SUITES'], secrets: [] },
      ],
    });

    const map = buildEnvPolicyMap(compiled, { extraKeyPolicy });
    const dbDev = map.get('db-dev');
    expect(dbDev).toBeTruthy();
    expect(dbDev.allowedVarsRaw).toContain('VERIFY_CORE_ALLOW_EXTENDED_SUITES');
  });
});
