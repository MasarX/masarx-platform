const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const script = 'scripts/deploy/append-function-cors.mjs';
const variables = {
  API_GATEWAY_CORS_ALLOW_ORIGINS: 'https://console.example.test',
  LABEL_RENDERER_CORS_ALLOW_ORIGINS: 'https://console.example.test,https://portal.example.test',
  LANDING_CORS_ALLOW_ORIGINS: 'https://landing.example.test',
  PUBLIC_TRACKING_CORS_ALLOW_ORIGINS: 'https://landing.example.test,https://portal.example.test',
};
const existing = 'EDGE_REQUIRE_DB_JWT=1\n';

function runWriter(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-function-cors-'));
  const file = path.join(dir, 'edge.env');
  try {
    fs.writeFileSync(file, existing);
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...variables, ...overrides, EDGE_SECRET_FILE: file },
    });
    return { ...result, contents: fs.readFileSync(file, 'utf8') };
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(dir);
  }
}

test('binds each hosted function CORS input from GitHub variables and validates before deploying', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8'));
  const deploy = workflow.jobs.database.steps.find(step => step.id === 'deploy');
  for (const key of Object.keys(variables)) {
    expect(deploy.env[key]).toBe('${{ vars.' + key + ' }}');
  }
  expect(deploy.run).toContain('export EDGE_SECRET_FILE="$secret_file"');
  expect(deploy.run).toContain('set -euo pipefail');
  const lines = deploy.run.split('\n');
  const validation = lines.indexOf(`node ${script}`);
  expect(validation).toBeGreaterThan(-1);
  expect(validation).toBeLessThan(lines.findIndex(line => line.startsWith('"$cli" db push ')));
  expect(validation).toBeLessThan(lines.findIndex(line =>
    line.startsWith('"$cli" secrets set ') && line.endsWith('--env-file "$secret_file"'),
  ));
});

test('appends the primary allowlists to the existing env file and logs counts only', () => {
  const result = runWriter();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.contents).toBe(existing + [
    `API_GATEWAY_CORS_ALLOW_ORIGINS=${variables.API_GATEWAY_CORS_ALLOW_ORIGINS}`,
    `LABEL_RENDERER_CORS_ALLOW_ORIGINS=${variables.LABEL_RENDERER_CORS_ALLOW_ORIGINS}`,
    `MARKETING_CORS_ALLOW_ORIGINS=${variables.LANDING_CORS_ALLOW_ORIGINS}`,
    `TENANT_SIGNUP_CORS_ALLOW_ORIGINS=${variables.LANDING_CORS_ALLOW_ORIGINS}`,
    `DRIVER_SIGNUP_CORS_ALLOW_ORIGINS=${variables.LANDING_CORS_ALLOW_ORIGINS}`,
    `PUBLIC_TRACKING_CORS_ALLOW_ORIGINS=${variables.PUBLIC_TRACKING_CORS_ALLOW_ORIGINS}`,
    '',
  ].join('\n'));
  expect(result.stdout.trim().split(/\r?\n/)).toEqual(Object.entries(variables).map(
    ([key, value]) => `${key}: ${value.split(',').length} origin(s)`,
  ));
});

test.each([
  ['', 'Set the PUBLIC_TRACKING_CORS_ALLOW_ORIGINS environment variable'],
  ...[
    'http://example.test',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://localhost:3000',
    'https://[::1]:3000',
    'https://portal.example.test/path',
    'https://portal.example.test?query',
    'https://user@portal.example.test',
    'https://*.example.test',
    'https://portal.example.test, https://landing.example.test',
    'https://portal.example.test,',
    'https://portal.example.test\nINJECTED=1',
  ].map(value => [value, 'PUBLIC_TRACKING_CORS_ALLOW_ORIGINS must be a comma-separated list']),
])('rejects the invalid configured tracking list %j without appending or printing it', (value, error) => {
  const result = runWriter({ PUBLIC_TRACKING_CORS_ALLOW_ORIGINS: value });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(error);
  if (value) expect(result.stderr).not.toContain(value);
  expect(result.stdout).toBe('');
  expect(result.contents).toBe(existing);
});
