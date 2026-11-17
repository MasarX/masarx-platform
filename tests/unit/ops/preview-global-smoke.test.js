jest.mock('../../../scripts/utils/load-env', () => ({
  loadEnv: jest.fn(),
}));

jest.mock('../../../scripts/ops/preview/shared', () => ({
  die: jest.fn((prefix, message) => {
    throw new Error(`${prefix}:${message}`);
  }),
  evaluateManifestRuntimeReadiness: jest.fn(),
  resolveTopologyIdentity: jest.fn(() => ({ topology: 'pr', id: '2049', sha: 'abc1234' })),
  resolveManifestPath: jest.fn(() => '.tmp/preview-manifests/pr-2049-abc1234.json'),
  readJsonFile: jest.fn(),
  resolveSurfaceUrl: jest.fn(() => ''),
  writeJsonFile: jest.fn(),
  runNodeScript: jest.fn(),
  printOutputs: jest.fn(),
  parseCommonCli: jest.fn(() => ({ args: {}, format: '' })),
}));

const { loadEnv } = require('../../../scripts/utils/load-env');
const shared = require('../../../scripts/ops/preview/shared');
const { runGlobalSmoke } = require('../../../scripts/ops/preview/global-smoke');

describe('preview global smoke', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    shared.readJsonFile.mockReturnValue({
      surfaces: {
        db: {
          status: 'prewarmed',
        },
      },
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('fails early on manifest runtime precheck and skips workflow intake smoke', async () => {
    shared.evaluateManifestRuntimeReadiness.mockReturnValue({
      ready: false,
      failure_class: 'preview-jwt-unready',
      env_file: 'C:\\tmp\\preview.env',
      runtime_ready_at: '',
    });
    process.env.DATABASE_URL = 'postgresql://stale.example/postgres';

    await expect(runGlobalSmoke()).rejects.toThrow('Global smoke failed: preview-jwt-unready');

    expect(loadEnv).toHaveBeenCalledTimes(2);
    expect(process.env.ENV_FILE).toBe('C:\\tmp\\preview.env');
    expect(process.env.ENV_FILE_OVERRIDE).toBe('1');
    expect(shared.runNodeScript).not.toHaveBeenCalled();
    const report = shared.writeJsonFile.mock.calls[0][1];
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'preview_runtime_precheck',
          ok: false,
          failure_class: 'preview-jwt-unready',
        }),
        expect.objectContaining({
          check: 'workflow_intake_smoke',
          skipped: true,
          reason: 'preview_runtime_unready',
        }),
      ]),
    );
  });

  test('runs workflow intake smoke once preview runtime is ready', async () => {
    shared.evaluateManifestRuntimeReadiness.mockReturnValue({
      ready: true,
      failure_class: '',
      env_file: 'C:\\tmp\\preview.env',
      runtime_ready_at: '2026-03-18T01:02:03.000Z',
    });
    process.env.DATABASE_URL = 'postgresql://preview.example/postgres';

    await expect(runGlobalSmoke()).resolves.toMatchObject({
      report: expect.objectContaining({
        failure_count: 0,
      }),
    });

    expect(loadEnv).toHaveBeenCalledTimes(2);
    expect(shared.runNodeScript).toHaveBeenCalledWith(expect.objectContaining({
      label: 'workflow-intake-smoke',
    }));
    const report = shared.writeJsonFile.mock.calls[0][1];
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'preview_runtime_precheck',
          ok: true,
        }),
        expect.objectContaining({
          check: 'workflow_intake_smoke',
          ok: true,
        }),
      ]),
    );
  });
});
