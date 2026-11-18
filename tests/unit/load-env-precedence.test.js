jest.mock('fs', () => ({ existsSync: jest.fn() }));
jest.mock('../../scripts/utils/env-file', () => ({
  configEnvFile: jest.fn(),
  resolveDotenvModule: jest.fn(() => ({})),
}));

const fs = require('fs');
const path = require('path');
const { configEnvFile } = require('../../scripts/utils/env-file');
const { loadEnv } = require('../../scripts/utils/load-env');

const explicitFile = path.join(process.cwd(), 'fixture', 'test.env');
const fallbackFiles = [
  path.join(process.cwd(), 'config', 'env', '.env.cloud'),
  path.join(process.cwd(), 'config', 'env', '.env.local'),
  path.join(process.cwd(), 'config', 'env', '.env'),
  path.join(process.cwd(), '.env'),
];

beforeEach(() => {
  jest.replaceProperty(process, 'env', { ENV_FILE: 'fixture/test.env' });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  fs.existsSync.mockReset().mockReturnValue(true);
  configEnvFile.mockReset();
});

afterEach(() => jest.restoreAllMocks());

test('loads only the explicit file by default and preserves the process environment', () => {
  loadEnv();
  expect(configEnvFile.mock.calls).toEqual([[explicitFile, { override: false }]]);
});

test('allows explicit overrides and appends fallback files without overriding values', () => {
  process.env.ENV_FILE_OVERRIDE = 'true';
  process.env.ENV_FILE_APPEND = 'true';
  loadEnv();
  expect(configEnvFile.mock.calls).toEqual([
    [explicitFile, { override: true }],
    ...fallbackFiles.map((file) => [file, { override: false }]),
  ]);
});

test('uses the ordered fallback files when the explicit fixture is missing', () => {
  fs.existsSync.mockImplementation((file) => file !== explicitFile);
  loadEnv();
  expect(configEnvFile.mock.calls).toEqual(fallbackFiles.map((file) => [file, { override: false }]));
});
