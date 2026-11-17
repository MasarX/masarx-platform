jest.mock('../../../scripts/utils/load-env', () => ({
  loadEnv: jest.fn(),
}));

jest.mock('../../../scripts/ops/gates/ui-surface-smoke', () => ({
  run: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { run } = require('../../../scripts/ops/gates/ui-surface-smoke');
const {
  parseArgs,
  readPositiveInt,
  runUiResourcePreflight,
} = require('../../../scripts/ops/gates/ui-resource-preflight');

describe('ui-resource-preflight', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CONSOLE_BASE_URL: 'https://unjijvxjrwurjgsnokovrvom.example.invalid',
      PORTAL_BASE_URL: 'https://hrorzpuminkttynstpljzjuu.example.invalid',
      DEPLOY_UI_READY_MAX_WAIT_MS: '20000',
      DEPLOY_UI_READY_RETRY_DELAY_MS: '4000',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('parseArgs accepts summary-out flags', () => {
    expect(parseArgs(['--summary-out', 'tmp/ui-resource-preflight.json'])).toEqual({
      'summary-out': 'tmp/ui-resource-preflight.json',
    });
  });

  test('readPositiveInt falls back on invalid values', () => {
    process.env.TEST_POSITIVE_INT = 'invalid';
    expect(readPositiveInt('TEST_POSITIVE_INT', 42)).toBe(42);
  });

  test('writes ready summary when ui smoke succeeds', async () => {
    const summaryPath = path.join(process.cwd(), '.tmp', 'tests', 'ui-resource-preflight.json');
    fs.rmSync(summaryPath, { force: true });
    run.mockResolvedValue({
      results: [{ label: 'console', status: 200, ok: true }],
    });

    const result = await runUiResourcePreflight({
      argv: ['--summary-out', summaryPath],
    });

    expect(run).toHaveBeenCalled();
    expect(result.summary.status).toBe('passed');
    expect(result.summary.ui_state).toBe('ready');
    expect(result.summary.full_gate_ran).toBe(false);
    expect(fs.existsSync(summaryPath)).toBe(true);
  });

  test('classifies unavailable hosted resources before full gate runs', async () => {
    const summaryPath = path.join(process.cwd(), '.tmp', 'tests', 'ui-resource-preflight-failed.json');
    fs.rmSync(summaryPath, { force: true });
    run.mockRejectedValue(new Error('Smoke check failed for console (https://unjijvxjrwurjgsnokovrvom.example.invalid) after 1 attempt(s): console returned HTTP 503'));

    await expect(runUiResourcePreflight({
      argv: ['--summary-out', summaryPath],
    })).rejects.toMatchObject({
      summary: expect.objectContaining({
        status: 'failed',
        failure_class: 'resource-unavailable',
        full_gate_ran: false,
      }),
    });

    const payload = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(payload.failure_class).toBe('resource-unavailable');
  });
});
