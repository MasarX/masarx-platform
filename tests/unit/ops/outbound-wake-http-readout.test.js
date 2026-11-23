const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const workflow = yaml.parse(readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8'));
const job = workflow.jobs['api-schemas'];
const step = job.steps.find(({ name }) => name === 'Read outbound wake HTTP diagnostics');
const unavailable = 'outbound_wake_http=UNREADABLE reason=request-correlation-unavailable\n';
const relayRow = { function_name: 'outbound-wake', status_code: 202, status_count: '60' };

function runDiagnostics(fixture, overrides = {}) {
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
  const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
    cwd: root,
    env: {
      ...process.env,
      DEPLOY_ENV: 'dev',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_STEP_SUMMARY: '/dev/null',
      SUPABASE_PROJECT_REF: randomUUID().replace(/[-0-9]/g, 'a').slice(0, 20),
      SUPABASE_ACCESS_TOKEN: randomUUID(),
      LOGS_FIXTURE: JSON.stringify(fixture),
      LOGS_HTTP_CODE: '200',
      LOGS_CURL_STATUS: '0',
      ...overrides,
    },
    input: `curl() {
      cat >/dev/null
      while (( $# )); do
        if [[ "$1" == --output ]]; then
          printf '%s' "$LOGS_FIXTURE" > "$2"
          break
        fi
        shift
      done
      printf '%s' "$LOGS_HTTP_CODE"
      return "$LOGS_CURL_STATUS"
    }
    ${step.run}`,
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.replace(/\r/g, '');
}

test('relay diagnostics query only the two Edge paths and aggregate status counts at the source', () => {
  expect(step.if).toBe('${{ !cancelled() }}');
  expect(job.environment).toBe('dev');
  expect(step.run).toContain("WHERE source = 'function_edge_logs'");
  expect(step.run).toContain("IN ('/functions/v1/outbound-wake', '/functions/v1/api-caller')");
  expect(step.run).toContain('GROUP BY function_name, status_code');
  expect(step.run).toContain('end_epoch - 3600');
  expect(step.run).toContain('/analytics/endpoints/logs');
});

test.each([
  [{ result: [relayRow, { function_name: 'api-caller', status_code: 401, status_count: '4' }], error: null },
    '{"outbound-wake":{"202":60},"api-caller":{"401":4}}'],
  [{ result: [], error: null }, '{"outbound-wake":{},"api-caller":{}}'],
])('relay diagnostics emit only the two fixed status maps (case %#)', (fixture, expected) => {
  expect(runDiagnostics(fixture)).toBe(`${unavailable}edge_status_60m=${expected}\n`);
});

test.each([
  ['extra fields', () => [{ ...relayRow, url: `https://${randomUUID()}.invalid`, host: randomUUID(), headers: { authorization: randomUUID() }, id: randomUUID() }]],
  ['unexpected function', () => [{ ...relayRow, function_name: randomUUID() }]],
  ['invalid status', () => [{ ...relayRow, status_code: 600 }]],
  ['invalid count', () => [{ ...relayRow, status_count: '1\n' }]],
  ['duplicate status', () => [relayRow, relayRow]],
])('relay diagnostics redact invalid upstream rows with %s', (_case, rows) => {
  expect(runDiagnostics({ result: rows(), error: null })).toBe(`${unavailable}edge_status_60m=UNREADABLE reason=validate\n`);
});

test('relay diagnostics fail soft and redact the management error response', () => {
  const fixture = { error: `https://${randomUUID()}.invalid/${randomUUID()}`, result: [] };
  expect(runDiagnostics(fixture, { LOGS_HTTP_CODE: '403', LOGS_CURL_STATUS: '22' }))
    .toBe(`${unavailable}edge_status_60m=UNREADABLE reason=http-403\n`);
  expect(runDiagnostics(fixture)).toBe(`${unavailable}edge_status_60m=UNREADABLE reason=validate\n`);
});

test.each([
  { DEPLOY_ENV: 'prod' },
  { GITHUB_REF: 'refs/heads/feature' },
])('relay diagnostics refuse a non-DEV-main scope (case %#)', (scope) => {
  expect(runDiagnostics({ result: [relayRow] }, scope)).toBe('edge_status_60m=UNREADABLE reason=input\n');
});
