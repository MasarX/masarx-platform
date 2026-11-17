const {
  buildDeployEvidenceManifest,
  normalizePhaseRecord,
  parseCsv,
  validateDeployEvidenceManifest,
} = require('../../../scripts/ops/ci/deploy-evidence-manifest');

describe('deploy-evidence-manifest', () => {
  test('parseCsv trims empty values', () => {
    expect(parseCsv(' a, ,b ,, c ')).toEqual(['a', 'b', 'c']);
  });

  test('normalizePhaseRecord preserves phase status and failure class', () => {
    expect(normalizePhaseRecord({
      phase: 'ui_gate',
      status: 'failed',
      failure_class: 'resource-unavailable',
      duration_seconds: 120,
    }, 'tmp/ui.json')).toEqual({
      phase: 'ui_gate',
      status: 'failed',
      duration_seconds: 120,
      failure_class: 'resource-unavailable',
      source_path: 'tmp/ui.json',
    });
  });

  test('buildDeployEvidenceManifest summarizes deploy and verify phases', () => {
    const manifest = buildDeployEvidenceManifest({
      stage: 'stg',
      surface: 'db',
      sha: 'abc123',
      workflow: 'Deploy (Stg)',
      environment: 'db-stg',
      phases: [
        { phase: 'deploy', status: 'passed', duration_seconds: 300, failure_class: '' },
        { phase: 'core_verify', status: 'passed', duration_seconds: 60, failure_class: '' },
        { phase: 'ui_gate', status: 'failed', duration_seconds: 90, failure_class: 'resource-unavailable' },
      ],
      retryCount: 1,
      rollbackCount: 0,
      silentSkipCount: 0,
      owner: 'stg:db:abc123',
    });

    expect(manifest.status).toBe('failed');
    expect(manifest.deploy_success).toBe(true);
    expect(manifest.verify_success).toBe(false);
    expect(manifest.failure_classes).toEqual(['resource-unavailable']);
    expect(manifest.retry_count).toBe(1);
    expect(manifest.attempt_count).toBe(2);
  });

  test('buildDeployEvidenceManifest fails closed when deploy is skipped even if verify rows are skipped', () => {
    const manifest = buildDeployEvidenceManifest({
      stage: 'stg',
      surface: 'db',
      sha: 'abc123',
      workflow: 'Deploy (Stg)',
      environment: 'db-stg',
      phases: [
        { phase: 'deploy', status: 'skipped', duration_seconds: 0, failure_class: '' },
        { phase: 'core_verify', status: 'skipped', duration_seconds: 0, failure_class: '' },
      ],
      owner: 'stg:db:abc123',
    });

    expect(manifest.status).toBe('failed');
    expect(manifest.deploy_success).toBe(false);
    expect(manifest.verify_success).toBe(false);
  });

  test('validateDeployEvidenceManifest accepts a matching manifest', () => {
    const manifest = buildDeployEvidenceManifest({
      stage: 'stg',
      surface: 'db',
      sha: 'abc123',
      workflow: 'Deploy (Stg)',
      environment: 'db-stg',
      phases: [
        { phase: 'deploy', status: 'passed', duration_seconds: 300, failure_class: '' },
        { phase: 'core_verify', status: 'passed', duration_seconds: 60, failure_class: '' },
      ],
      owner: 'stg:db:abc123',
    });

    const result = validateDeployEvidenceManifest(manifest, {
      stage: 'stg',
      surface: 'db',
      sha: 'abc123',
      workflow: 'Deploy (Stg)',
      authoritativeOwner: 'stg:db:abc123',
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('validateDeployEvidenceManifest fails closed on deploy success, silent skips, and owner drift', () => {
    const manifest = {
      stage: 'stg',
      surface: 'db',
      sha: 'abc123',
      workflow: 'Deploy (Stg)',
      authoritative_owner: 'stg:db:different',
      status: 'passed',
      deploy_success: false,
      verify_success: true,
      silent_skip_count: 1,
      failed_phase_count: 0,
    };

    const result = validateDeployEvidenceManifest(manifest, {
      stage: 'stg',
      surface: 'db',
      sha: 'abc123',
      workflow: 'Deploy (Stg)',
      authoritativeOwner: 'stg:db:abc123',
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('deploy_success must be true');
    expect(result.errors.join('\n')).toContain('authoritative_owner mismatch');
    expect(result.errors.join('\n')).toContain('silent_skip_count must be 0');
  });
});
