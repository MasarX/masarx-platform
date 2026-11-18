const {
  findArtifactByName,
  fetchWorkflowArtifactBundleForRun,
  fetchWorkflowEvidenceForRun,
  readJsonEntriesFromZip,
  readJsonFromZip,
  listEntriesFromZip,
} = require('../../../scripts/ops/ci/github-workflow-artifacts');

describe('github-workflow-artifacts', () => {
  test('findArtifactByName matches the exact artifact name', () => {
    expect(
      findArtifactByName(
        [
          { name: 'one' },
          { name: 'target-artifact' },
        ],
        'target-artifact',
      ),
    ).toEqual({ name: 'target-artifact' });
  });

  test('fetchWorkflowEvidenceForRun returns missing_artifact when artifact is absent', async () => {
    const result = await fetchWorkflowEvidenceForRun({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      runId: 1,
      artifactName: 'missing',
      listArtifactsFn: async () => [{ name: 'other' }],
    });

    expect(result).toEqual({
      status: 'missing_artifact',
      manifest: null,
    });
  });

  test('fetchWorkflowEvidenceForRun returns parsed manifest when artifact is readable', async () => {
    const result = await fetchWorkflowEvidenceForRun({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      runId: 1,
      artifactName: 'stg-deploy-evidence',
      jsonEntrySuffix: 'deploy-stg-evidence-manifest.json',
      listArtifactsFn: async () => [
        { name: 'stg-deploy-evidence', archive_download_url: 'https://example.test/artifact.zip' },
      ],
      downloadBinaryFn: async ({ targetPath }) => targetPath,
      readJsonFromZipFn: () => ({ stage: 'stg', surface: 'db', sha: 'abc123' }),
      listEntriesFromZipFn: () => ['deploy-stg-evidence-manifest.json'],
    });

    expect(result).toEqual({
      status: 'ok',
      artifact_name: 'stg-deploy-evidence',
      manifest: { stage: 'stg', surface: 'db', sha: 'abc123' },
    });
  });

  test('fetchWorkflowArtifactBundleForRun returns requested JSON entries', async () => {
    const result = await fetchWorkflowArtifactBundleForRun({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      runId: 1,
      artifactName: 'stg-ui-verify-logs',
      jsonEntrySuffix: 'verify-ui-evidence-manifest.json',
      jsonEntrySuffixes: ['e2e-gate-summary.json', 'e2e-mandatory-pack.json'],
      listArtifactsFn: async () => [
        { name: 'stg-ui-verify-logs', archive_download_url: 'https://example.test/artifact.zip' },
      ],
      downloadBinaryFn: async ({ targetPath }) => targetPath,
      readJsonFromZipFn: () => ({ stage: 'stg', surface: 'ui', sha: 'abc123' }),
      readJsonEntriesFromZipFn: () => ({
        'verify-ui-evidence-manifest.json': { stage: 'stg', surface: 'ui', sha: 'abc123' },
        'e2e-gate-summary.json': { status: 'passed' },
        'e2e-mandatory-pack.json': { suites: [] },
      }),
      listEntriesFromZipFn: () => [
        'verify-ui-evidence-manifest.json',
        'e2e-gate-summary.json',
        'e2e-mandatory-pack.json',
      ],
    });

    expect(result.status).toBe('ok');
    expect(result.json_entries['e2e-gate-summary.json']).toEqual({ status: 'passed' });
    expect(result.json_entries['verify-ui-evidence-manifest.json']).toEqual({
      stage: 'stg',
      surface: 'ui',
      sha: 'abc123',
    });
  });

  test('fetchWorkflowEvidenceForRun returns artifact_error when the manifest cannot be read', async () => {
    const result = await fetchWorkflowEvidenceForRun({
      owner: 'MasarX',
      repo: 'MasarX',
      token: 't',
      runId: 1,
      artifactName: 'stg-deploy-evidence',
      listArtifactsFn: async () => [
        { name: 'stg-deploy-evidence', archive_download_url: 'https://example.test/artifact.zip' },
      ],
      downloadBinaryFn: async ({ targetPath }) => targetPath,
      readJsonFromZipFn: () => {
        throw new Error('bad zip');
      },
      listEntriesFromZipFn: () => ['deploy-stg-evidence-manifest.json'],
    });

    expect(result.status).toBe('artifact_error');
    expect(result.artifact_name).toBe('stg-deploy-evidence');
    expect(result.error).toContain('bad zip');
  });

  test('listEntriesFromZip returns bounded Node-parsed file entries', () => {
    const readZipArchiveFileFn = jest.fn().mockReturnValue([
      { name: 'dir/', isDirectory: true, data: Buffer.alloc(0) },
      { name: 'dir/manifest.json', isDirectory: false, data: Buffer.from('{}') },
    ]);

    expect(listEntriesFromZip('artifact.zip', { readZipArchiveFileFn })).toEqual([
      'dir/manifest.json',
    ]);
    expect(readZipArchiveFileFn).toHaveBeenCalledWith(
      'artifact.zip',
      { errorPrefix: 'workflow_artifact_zip' },
    );
  });

  test('readJsonFromZip keeps cross-platform archive paths data-only', () => {
    const archivePath = 'C:\\runner temp\\artifact [1].zip';
    const readZipArchiveFileFn = jest.fn().mockReturnValue([{
      name: 'nested/deploy-stg-evidence-manifest.json',
      isDirectory: false,
      data: Buffer.from('{"stage":"stg","surface":"db","sha":"abc123"}'),
    }]);

    const result = readJsonFromZip(archivePath, {
      entrySuffix: 'DEPLOY-STG-EVIDENCE-MANIFEST.JSON',
      readZipArchiveFileFn,
    });

    expect(result).toEqual({ stage: 'stg', surface: 'db', sha: 'abc123' });
    expect(readZipArchiveFileFn).toHaveBeenCalledWith(
      archivePath,
      { errorPrefix: 'workflow_artifact_zip' },
    );
  });

  test('readJsonEntriesFromZip reads multiple Node-parsed JSON entries', () => {
    const readZipArchiveFileFn = jest.fn().mockReturnValue([
      { name: 'e2e-gate-summary.json', isDirectory: false, data: Buffer.from('{"status":"passed"}') },
      { name: 'reports/load-summary.json', isDirectory: false, data: Buffer.from('{"status":"passed"}') },
    ]);

    const result = readJsonEntriesFromZip('artifact.zip', {
      entrySuffixes: ['e2e-gate-summary.json', 'load-summary.json'],
      readZipArchiveFileFn,
    });

    expect(result).toEqual({
      'e2e-gate-summary.json': { status: 'passed' },
      'load-summary.json': { status: 'passed' },
    });
    expect(readZipArchiveFileFn).toHaveBeenCalledWith(
      'artifact.zip',
      { errorPrefix: 'workflow_artifact_zip' },
    );
  });

  test('readJsonFromZip rejects malformed UTF-8 from the archive', () => {
    const readZipArchiveFileFn = jest.fn().mockReturnValue([{
      name: 'manifest.json',
      isDirectory: false,
      data: Buffer.from([0x7b, 0xc3, 0x28, 0x7d]),
    }]);

    expect(() => readJsonFromZip('artifact.zip', {
      entrySuffix: 'manifest.json',
      readZipArchiveFileFn,
    })).toThrow(/encoded data was not valid/i);
  });

});
