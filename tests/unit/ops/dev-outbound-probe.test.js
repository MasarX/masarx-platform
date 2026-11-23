const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const { transpileModule } = require('typescript');
const yaml = require('yaml');
const { loadRegistry, planDeploy } = require('../../../scripts/edge/functions-registry');

const root = path.resolve(__dirname, '../../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const workflow = yaml.parse(read('.github/workflows/dev-outbound-probe.yml'));
const deploy = yaml.parse(read('.github/workflows/deploy.yml'));
const targetName = 'outbound-probe-ack';
const scriptName = 'scripts/deploy/dev-outbound-probe.sh';
const fixtureRef = 'abcdefghijklmnopqrst';
const completedMetrics = '21|21|0|0|1|20|21|190|240|192|247|0|0|0|0';
const metricNames = [
  'probe_enqueued', 'probe_completed', 'probe_failed', 'probe_pending', 'probe_relay_completed',
  'probe_inline_samples', 'probe_edge_samples', 'probe_inline_p50_ms', 'probe_inline_p95_ms',
  'probe_edge_p50_ms', 'probe_edge_p95_ms',
  'probe_failed_egress_proxy_unavailable', 'probe_failed_egress_proxy_misconfigured',
  'probe_failed_egress_proxy_request_failed', 'probe_failed_other',
];
const output = metrics => metrics.split('|').map((value, i) => metricNames[i] + '=' + (value || 'null') + '\n').join('');

test('dispatch requires dev and main and shares the database apply concurrency group', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
    environment: { type: 'choice', required: true, options: ['dev'] },
    probe_count: { type: 'number', default: 20 },
  });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  const job = workflow.jobs.probe;
  expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.environment == 'dev' && github.ref == 'refs/heads/main'");
  expect(job.environment).toBe('dev');
  expect(job.concurrency).toEqual(deploy.jobs.database.concurrency);
  expect(job.steps[0]).toEqual({
    uses: expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/),
    with: { ref: '${{ github.sha }}', 'persist-credentials': false },
  });
  expect(job.steps[1].run).toBe('bash ' + scriptName);
  expect(job.steps[1].env.SUPABASE_PROJECT_REF).toBe('${{ vars.SUPABASE_PROJECT_REF }}');
  expect(read(scriptName)).not.toMatch(new RegExp('https://[a-z0-9]+[.]supabase[.]co/', 'i'));
});

test('only the DEV deployment plan contains the credential-free acknowledgement', () => {
  const registry = loadRegistry();
  expect(planDeploy(registry, 'dev').noVerifyJwt).toContainEqual({
    name: targetName, authMode: 'public_no_jwt', enabled: true, environments: ['dev'],
  });
  for (const environment of ['stg', 'prod', undefined]) {
    expect(Object.values(planDeploy(registry, environment)).flat().map(({ name }) => name)).not.toContain(targetName);
  }
  const prepare = deploy.jobs.database.steps.find(step => step.name === 'Prepare edge packages and pinned CLI');
  expect(prepare.run).toContain('functionsForDeploy(functions, process.env.DEPLOY_ENV)');
});

function runProbe(env = {}) {
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
  const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
    cwd: root,
    input: String.raw`
curl() {
  case "$*" in
    */config/database/pooler) cat >/dev/null ;;
    *--output*) ;;
    *) exit 91 ;;
  esac
}
jq() { cat >/dev/null; printf '%s\n' "$MOCK_POOLER"; }
sha256sum() { cat >/dev/null; }
timeout() { shift; "$@"; }
sleep() { METRICS="$AFTER_WAIT"; SECONDS=600; }
psql() {
  local sql
  sql=$(cat)
  [[ "$PGHOST" == "$MOCK_POOLER" && "$PGSSLMODE" == verify-full ]] || return 92
  if [[ "$sql" == *public.enqueue_outbound_call_from_operation_template_v1* ]]; then
    [[ "$*" == *"probe_base=$EXPECTED_BASE"* ]] || return 93
    [[ "$(grep -Fc '\set lane relay' <<< "$sql")" == 1 ]] || return 94
    [[ "$(grep -Fc '\set lane inline' <<< "$sql")" == "$EXPECTED_INLINE" ]] || return 95
    [[ "$(grep -Fc 'COMMIT;' <<< "$sql")" == "$((EXPECTED_INLINE + 2))" ]] || return 96
    [[ "$sql" == *public.dispatch_outbound_call_inline* && "$sql" == *'probe_marker'* ]] || return 97
    [[ "$sql" == *'/outbound-probe-ack'* && "$sql" != *'INSERT INTO public.outbound_calls'* ]] || return 98
    if [[ -n "$ENQUEUE_FAILURE" ]]; then
      printf '%s\n' "$EXPECTED_BASE" >&2
      return 3
    fi
    printf 'ready\n'
  else
    [[ "$sql" == *'BEGIN READ ONLY'* && "$sql" == *"a.row_old->>'status' = 'in_progress_edge'"* &&
       "$sql" == *"a.row_old->>'edge_lease_token' IS NOT NULL"* ]] || return 99
    printf '%s\n' "$METRICS"
  fi
}
source scripts/deploy/dev-outbound-probe.sh
`,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', DEPLOY_ENV: 'dev',
      GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_STEP_SUMMARY: '/dev/null',
      PROBE_COUNT: '', SUPABASE_PROJECT_REF: fixtureRef,
      SUPABASE_ACCESS_TOKEN: 'access-fixture', SUPABASE_DB_PASSWORD: 'password-fixture',
      MOCK_POOLER: ['aws-0-ci', 'pooler', 'supabase', 'com'].join('.'),
      EXPECTED_BASE: 'https://' + [fixtureRef, 'supabase', 'co'].join('.') + '/functions/v1',
      EXPECTED_INLINE: '20', METRICS: completedMetrics, ENQUEUE_FAILURE: '', AFTER_WAIT: completedMetrics,
      ...env,
    },
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.replace(/\r/g, ''), stderr: result.stderr };
}

test.each([
  { DEPLOY_ENV: 'stg' }, { DEPLOY_ENV: 'prod' }, { GITHUB_REF: 'refs/heads/other' },
  { GITHUB_EVENT_NAME: 'push' }, { PROBE_COUNT: '19' }, { PROBE_COUNT: '51' },
  { PROBE_COUNT: '20.5' }, { PROBE_COUNT: '020' }, { SUPABASE_PROJECT_REF: 'invalid' },
])('refuses invalid binding or sample count %j', env => {
  expect(runProbe(env)).toEqual({ status: 1, stdout: '', stderr: '' });
});

test.each([20, 50])('enqueues %i inline samples and one relay control without disclosing identifiers', count => {
  const metrics = [count + 1, count + 1, 0, 0, 1, count, count + 1, 190, 240, 192, 247, 0, 0, 0, 0].join('|');
  expect(runProbe({ PROBE_COUNT: count === 20 ? '' : String(count), EXPECTED_INLINE: String(count), METRICS: metrics }))
    .toEqual({ status: 0, stdout: output(metrics), stderr: '' });
});

test.each([
  ['no completion', '21|0|21|0|0|0|0|||||0|0|0|21'],
  ['inline work alone does not prove the relay', '21|20|1|0|0|20|20|120|240|120|240|0|0|0|1'],
  ['insufficient inline samples', '21|20|1|0|1|19|20|||120|240|0|0|0|1'],
  ['deadline with work pending', '21|0|0|21|0|0|0|||||0|0|0|0'],
  ['leased calls fail closed at the proxy', '21|0|21|0|0|0|0|||||18|1|1|1'],
])('returns aggregate metrics and fails on %s', (_label, metrics) => {
  expect(runProbe({ METRICS: metrics, AFTER_WAIT: metrics })).toEqual({ status: 1, stdout: output(metrics), stderr: '' });
});

test('waits for pending work to complete before reporting', () => {
  expect(runProbe({ METRICS: '21|0|0|21|0|0|0|||||0|0|0|0' }))
    .toEqual({ status: 0, stdout: output(completedMetrics), stderr: '' });
});

test('reports partial writes without disclosing a database failure', () => {
  const metrics = '1|1|0|0|1|0|1|||192|192|0|0|0|0';
  expect(runProbe({ ENQUEUE_FAILURE: '1', METRICS: metrics })).toEqual({ status: 1, stdout: output(metrics), stderr: '' });
});

test('rejects mixed or unexpectedly shaped database output', () => {
  expect(runProbe({ METRICS: completedMetrics + '\nprivate-value' })).toEqual({ status: 1, stdout: '', stderr: '' });
});

test('maps fixed api-caller errors to count labels without projecting database error text', () => {
  const script = read(scriptName);
  const caller = read('supabase/functions/api-caller/egress.mjs') + read('supabase/functions/api-caller/proxy.mjs');
  const reasonCase = script.split('CASE\n      WHEN o.error_message')[1].split('END AS failure_reason')[0];
  const knownMessages = [...reasonCase.matchAll(/'(Egress policy violation: guarded proxy[^']+|(?:Guarded egress proxy|Deno guarded proxy)[^']+)'/g)];
  expect(knownMessages).toHaveLength(8);
  for (const [, message] of knownMessages) expect(caller).toContain('"' + message + '"');
  expect(script.split('SELECT count(*)')[1]).not.toContain('error_message');
});

const serve = jest.fn();
runInNewContext(transpileModule(read('supabase/functions/' + targetName + '/index.ts'), {}).outputText, { Deno: { serve }, Response });
const handler = serve.mock.calls[0][0];
const requestUrl = 'https://' + ['probe', 'test'].join('.') + '/?query=fixture-query';

test('returns a fixed acknowledgement without reading the request body or reflecting request data', async () => {
  const req = new Request(requestUrl, {
    method: 'POST', headers: { 'content-length': '4096', 'x-probe-header': 'fixture-header' }, body: 'fixture-body',
  });
  const response = handler(req);
  expect(response.status).toBe(200);
  expect([...response.headers]).toEqual([['content-type', 'application/json']]);
  expect(await response.text()).toBe('{"ok":true}');
  expect(req.bodyUsed).toBe(false);
});

test.each([
  ['POST', '4097'], ['POST', undefined], ['GET', '4097'], ['POST', '1, 2'], ['POST', '-1'],
])('refuses %s with Content-Length %s without reading the body', (method, length) => {
  const req = new Request(requestUrl, {
    method, headers: length === undefined ? {} : { 'content-length': length },
    body: method === 'POST' ? 'fixture-body' : undefined,
  });
  const response = handler(req);
  expect(response.status).toBe(413);
  expect(response.body).toBeNull();
  expect(req.bodyUsed).toBe(false);
});

test.each(['GET', 'HEAD', 'OPTIONS'])('accepts bodyless %s without Content-Length', async method => {
  const response = handler(new Request(requestUrl, { method }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(method === 'HEAD' ? '' : '{"ok":true}');
});
