const path = require('path');

const {
  compilePolicy,
  buildDeletionPlan,
  applyStoragePressurePlan,
  resolveArtifactRule,
  normalizeRepo,
  listArtifacts,
} = require(path.join(process.cwd(), 'scripts', 'ops', 'ci', 'prune-actions-artifacts.js'));

describe('prune-actions-artifacts', () => {
  test('normalizes repo names', () => {
    expect(normalizeRepo('MasarX/MasarX')).toEqual({ owner: 'MasarX', repo: 'MasarX' });
    expect(normalizeRepo('badrepo')).toEqual({ owner: '', repo: '' });
  });

  test('applies heavy preview and proof retention rules', () => {
    const policy = compilePolicy({
      version: 1,
      default_retention_hours: 168,
      rules: [
        { name: 'heavy', pattern: '^(pr-gate-|reviewer-gate-preview-)', max_age_hours: 72 },
        { name: 'proof', pattern: '^(dev-deploy-evidence)', max_age_hours: 720 },
      ],
    });

    expect(resolveArtifactRule('pr-gate-PLAN-123', policy)).toMatchObject({ name: 'heavy', maxAgeHours: 72 });
    expect(resolveArtifactRule('dev-deploy-evidence', policy)).toMatchObject({ name: 'proof', maxAgeHours: 720 });
    expect(resolveArtifactRule('misc-artifact', policy)).toMatchObject({ name: 'default', maxAgeHours: 168 });
  });

  test('repo policy keeps done-audit artifacts short-lived and stg UI evidence bounded', () => {
    const policy = compilePolicy(require(path.join(
      process.cwd(),
      'config',
      'ci',
      'actions-artifact-retention-policy.json',
    )));

    expect(resolveArtifactRule('done-audit-12345', policy)).toMatchObject({
      name: 'done_audit_outputs',
      maxAgeHours: 72,
    });
    expect(resolveArtifactRule('done-audit-sweep-12345', policy)).toMatchObject({
      name: 'done_audit_outputs',
      maxAgeHours: 72,
    });
    expect(resolveArtifactRule('stg-ui-verify-logs', policy)).toMatchObject({
      name: 'proof_and_ops_summaries',
      maxAgeHours: 168,
    });
  });

  test('builds a deletion plan from artifact ages and policy windows', () => {
    const now = Date.parse('2026-03-31T00:00:00Z');
    const policy = compilePolicy({
      version: 1,
      default_retention_hours: 168,
      rules: [
        { name: 'heavy', pattern: '^(pr-gate-)', max_age_hours: 72 },
      ],
    });

    const plan = buildDeletionPlan([
      {
        id: 1,
        name: 'pr-gate-PLAN-1',
        size_in_bytes: 1024,
        created_at: '2026-03-20T00:00:00Z',
        expired: false,
      },
      {
        id: 2,
        name: 'dev-deploy-evidence',
        size_in_bytes: 256,
        created_at: '2026-03-30T12:00:00Z',
        expired: false,
      },
    ], policy, now);

    const staleHeavy = plan.find((row) => row.id === 1);
    const recentProof = plan.find((row) => row.id === 2);

    expect(staleHeavy.delete).toBe(true);
    expect(staleHeavy.ruleName).toBe('heavy');
    expect(recentProof.delete).toBe(false);
    expect(recentProof.ruleName).toBe('default');
  });

  test('adds older artifacts to the deletion plan under storage pressure', () => {
    const now = Date.parse('2026-03-31T00:00:00Z');
    const policy = compilePolicy({
      version: 1,
      default_retention_hours: 168,
      rules: [],
    });

    const plan = buildDeletionPlan([
      {
        id: 1,
        name: 'recent-small',
        size_in_bytes: 100,
        created_at: '2026-03-30T23:00:00Z',
        expired: false,
      },
      {
        id: 2,
        name: 'old-large',
        size_in_bytes: 900,
        created_at: '2026-03-29T00:00:00Z',
        expired: false,
      },
    ], policy, now);

    const pressured = applyStoragePressurePlan(plan, {
      maxTotalBytes: 800,
      targetTotalBytes: 100,
      minAgeHours: 6,
    });

    const oldLarge = pressured.find((row) => row.id === 2);
    const recentSmall = pressured.find((row) => row.id === 1);
    expect(oldLarge.delete).toBe(true);
    expect(oldLarge.deleteReason).toBe('storage_pressure');
    expect(recentSmall.delete).toBe(false);
  });

  test('listArtifacts stops cleanly when GitHub returns 404 for a later page', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `artifact-${index + 1}`,
    }));
    const requestFn = jest
      .fn()
      .mockResolvedValueOnce({ artifacts: pageOne })
      .mockRejectedValueOnce(
        new Error(
          'GitHub API GET https://api.github.com/repos/MasarX/MasarX/actions/artifacts?per_page=100&page=2 failed (404): {"message":"Not Found"}',
        ),
      );

    const result = await listArtifacts({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 'token',
      requestFn,
    });

    expect(result).toHaveLength(100);
    expect(result[0]).toMatchObject({ id: 1, name: 'artifact-1' });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  test('listArtifacts still fails closed on a first-page 404', async () => {
    const requestFn = jest.fn().mockRejectedValue(
      new Error(
        'GitHub API GET https://api.github.com/repos/MasarX/MasarX/actions/artifacts?per_page=100&page=1 failed (404): {"message":"Not Found"}',
      ),
    );

    await expect(listArtifacts({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 'token',
      requestFn,
    })).rejects.toThrow('failed (404)');
  });
});
