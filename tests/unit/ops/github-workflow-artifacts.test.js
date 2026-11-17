const {
  findArtifactByName,
  fetchWorkflowArtifactBundleForRun,
  fetchWorkflowEvidenceForRun,
  readJsonEntriesFromZip,
  readJsonFromZip,
  resolvePythonExecutable,
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

  test('resolvePythonExecutable prefers python3 on linux-like platforms', () => {
    const execFileSyncFn = jest
      .fn()
      .mockReturnValueOnce('Python 3.12.1');

    const result = resolvePythonExecutable({
      platform: 'linux',
      execFileSyncFn,
    });

    expect(result).toBe('python3');
    expect(execFileSyncFn).toHaveBeenCalledWith('python3', ['--version'], { stdio: 'pipe' });
  });

  test('resolvePythonExecutable falls back to python when python3 is unavailable', () => {
    const execFileSyncFn = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('missing python3');
      })
      .mockReturnValueOnce('Python 3.11.9');

    const result = resolvePythonExecutable({
      platform: 'linux',
      execFileSyncFn,
    });

    expect(result).toBe('python');
    expect(execFileSyncFn).toHaveBeenNthCalledWith(1, 'python3', ['--version'], { stdio: 'pipe' });
    expect(execFileSyncFn).toHaveBeenNthCalledWith(2, 'python', ['--version'], { stdio: 'pipe' });
  });

  test('readJsonFromZip reads JSON via python zipfile fallback', () => {
    const execFileSyncFn = jest
      .fn()
      .mockReturnValueOnce('Python 3.11.9')
      .mockReturnValueOnce('{"stage":"stg","surface":"db","sha":"abc123"}');

    const result = readJsonFromZip('artifact.zip', {
      entrySuffix: 'deploy-stg-evidence-manifest.json',
      platform: 'linux',
      execFileSyncFn,
    });

    expect(result).toEqual({ stage: 'stg', surface: 'db', sha: 'abc123' });
    expect(execFileSyncFn).toHaveBeenNthCalledWith(1, 'python3', ['--version'], { stdio: 'pipe' });
    expect(execFileSyncFn).toHaveBeenNthCalledWith(
      2,
      'python3',
      expect.arrayContaining([
        '-c',
        expect.stringContaining('zipfile.ZipFile'),
        'artifact.zip',
        'deploy-stg-evidence-manifest.json',
      ]),
      { encoding: 'utf8' },
    );
  });

  test('readJsonEntriesFromZip reads multiple JSON entries via python zipfile fallback', () => {
    const execFileSyncFn = jest
      .fn()
      .mockReturnValueOnce('Python 3.11.9')
      .mockReturnValueOnce('{"e2e-gate-summary.json":{"status":"passed"},"load-summary.json":{"status":"passed"}}');

    const result = readJsonEntriesFromZip('artifact.zip', {
      entrySuffixes: ['e2e-gate-summary.json', 'load-summary.json'],
      platform: 'linux',
      execFileSyncFn,
    });

    expect(result).toEqual({
      'e2e-gate-summary.json': { status: 'passed' },
      'load-summary.json': { status: 'passed' },
    });
    expect(execFileSyncFn).toHaveBeenNthCalledWith(
      2,
      'python3',
      expect.arrayContaining([
        '-c',
        expect.stringContaining('json.loads'),
        'artifact.zip',
        '["e2e-gate-summary.json","load-summary.json"]',
      ]),
      { encoding: 'utf8' },
    );
  });
});
