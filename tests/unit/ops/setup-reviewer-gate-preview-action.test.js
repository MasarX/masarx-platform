const fs = require('fs');
const path = require('path');

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

  test('assumes the caller already checked out the repository before setup-cloud-env', () => {
    const body = readAction();

    expect(body).toContain('Setup Node + deps');
    expect(body).toContain('uses: ./.github/actions/setup-cloud-env');
    expect(body).not.toContain('uses: actions/checkout@');
    expect(body).not.toContain('git sparse-checkout disable >/dev/null 2>&1 || true');
    expect(body).not.toContain('git read-tree -mu HEAD');
    expect(body).not.toContain('package-lock.json');
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
});
