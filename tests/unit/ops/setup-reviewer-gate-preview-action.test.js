const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

describe('setup-reviewer-gate-preview action contract', () => {
  const actionFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'actions',
    'setup-reviewer-gate-preview',
    'action.yml',
  );

  const readAction = () => fs.readFileSync(actionFile, 'utf8').replace(/\r\n/g, '\n');

  test('parses as a composite action without duplicate YAML keys', () => {
    const document = YAML.parseDocument(readAction(), { uniqueKeys: true });
    expect(document.errors).toEqual([]);
    expect(document.toJS()).toEqual(expect.objectContaining({
      runs: expect.objectContaining({ using: 'composite' }),
    }));
  });

  test('assumes the caller already checked out the repository before setup-cloud-env', () => {
    const body = readAction();

    expect(body).toContain('Setup Node + deps');
    expect(body).toContain('uses: ./.github/actions/setup-cloud-env');
    expect(body).toContain('cache-save: "false"');
    expect(body).not.toContain('uses: actions/checkout@');
    expect(body).not.toContain('git sparse-checkout disable >/dev/null 2>&1 || true');
    expect(body).not.toContain('git read-tree -mu HEAD');
    expect(body).not.toContain('package-lock.json');
  });

  test('does not duplicate legacy preview environment setup in the composite action', () => {
    const body = readAction();

    expect(body).not.toContain('Validate preview reusable env config');
    expect(body).not.toContain('for key in PREVIEW_SUPABASE_ACCESS_TOKEN');
  });

  test('resolves the exact preview manifest file instead of the first JSON artifact entry', () => {
    const body = readAction();

    expect(body).toContain('resolve-preview-artifact-manifest.js');
    expect(body).toContain('--artifact-dir ".tmp/reviewer-gate-preview-artifact"');
    expect(body).not.toContain("-name '*.json' | head -n 1");
  });

  test('retries transient preview manifest artifact download failures before resolving the manifest', () => {
    const body = readAction();

    expect(body).toContain('id: download_preview_manifest_1');
    expect(body).toContain('id: download_preview_manifest_2');
    expect(body).toContain('Download preview manifest artifact (final retry)');
    expect(body).toContain("if: steps.download_preview_manifest_1.outcome == 'failure'");
    expect(body).toContain("if: steps.download_preview_manifest_2.outcome == 'failure'");
    expect(body).toContain('rm -rf .tmp/reviewer-gate-preview-artifact');
  });

  test('revalidates and persists the runner-local DB route without password mutation', () => {
    const body = readAction();
    const ensureIndex = body.indexOf('Ensure preview env overlay');
    const revalidateIndex = body.indexOf('Revalidate preview DB route on this runner');
    const exportIndex = body.indexOf('Export preview manifest outputs');

    expect(revalidateIndex).toBeGreaterThan(ensureIndex);
    expect(exportIndex).toBeGreaterThan(revalidateIndex);
    expect(body).toContain('ENV_FILE: ${{ steps.preview_env.outputs.env_file }}');
    expect(body).toContain('ENV_FILE_OVERRIDE: "1"');
    expect(body).toContain('DB_CONNECT_CANDIDATE_POLICY: shared-lane-safe');
    expect(body).toContain('DB_SMOKE_SYNC_DB_PASSWORD: "0"');
    expect(body).toContain('DB_SMOKE_SYNC_ON_TENANT_NOT_FOUND: "0"');
    expect(body).toContain('DB_SMOKE_PERSIST_ENV_FILE: "1"');
    expect(body).toContain('node scripts/ops/db-connect-smoke.js');
    expect(body).not.toContain('DB_SMOKE_MAX_WAIT_MS:');
    expect(body).not.toContain('setProjectDatabasePassword');
  });
});
