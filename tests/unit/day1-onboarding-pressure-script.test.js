const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

function loadProfile({ env = {}, policy = {}, responses = [], random = () => 0.5 } = {}) {
  const tenant = { org_id: 'synthetic-org', client_id: 'synthetic-client', sender_id: 'synthetic-sender' };
  const db = { close: jest.fn(), query: jest.fn((text) => {
    if (text.includes('AS policy')) return [{ policy: JSON.stringify(policy) }];
    if (text.includes('FROM public.organizations')) return [tenant];
    if (text.includes('INSERT INTO public.shipments')) return [{ id: 'synthetic-shipment' }];
    return [];
  }) };
  const sleep = jest.fn();
  const log = jest.fn();
  const post = jest.fn(() => responses.shift() || { status: 503, body: '{}' });
  const modules = {
    k6: { sleep, check: (data, checks) => Object.values(checks).every(check => check(data)) },
    'k6/metrics': { Rate: class { add() {} }, Trend: class { add() {} } },
    'k6/http': { post },
    'k6/x/sql': { open: () => db },
    'k6/x/sql/driver/postgres': {},
  };
  const file = path.join(__dirname, '..', '..', 'tests', 'load', 'day1-onboarding-pressure.js');
  const source = fs.readFileSync(file, 'utf8') +
    '\nexport { readDay1LabelPressurePolicy, resolveLabelRetryPolicy, computeLabelRetrySleepMs };';
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, module: { exports }, require: name => {
      if (!(name in modules)) throw new Error('Unexpected dependency: ' + name);
      return modules[name];
    },
    __ENV: { DAY1_TENANTS: '1', SUPABASE_URL: 'https://synthetic.invalid',
      SUPABASE_ANON_KEY: 'synthetic-public', LABEL_RENDERER_DB_JWT: 'synthetic-private', ...env },
    __VU: 1, __ITER: 0, Math: Object.assign(Object.create(Math), { random }),
    console: { log, warn() {}, error() {} },
  });
  return { run: exports, db, sleep, post, log };
}

describe('day1 onboarding pressure script', () => {
  test('normalizes tracking/barcode token to shipment_boxes barcode constraint', () => {
    const file = path.join(__dirname, '..', '..', 'tests', 'load', 'day1-onboarding-pressure.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('function toBarcodeToken');
    expect(body).toMatch('/[^A-Z0-9]/g');
    expect(body).toMatch('function buildTrackingNumber');
    expect(body).toMatch('C${segmentClient}V${segmentVu}I${segmentIter}S${segmentSlot}T${segmentTime}');
    expect(body).toMatch('const trackingPrefix = toBarcodeToken(`DAY1-${runId}`);');
    expect(body).toMatch('const trackingNumber = buildTrackingNumber(data, tenant, slot);');
    expect(body).toMatch('const barcode = `${trackingNumber}:1`;');
  });

  test('retries teardown cleanup when session-mode max clients is reached', () => {
    const file = path.join(__dirname, '..', '..', 'tests', 'load', 'day1-onboarding-pressure.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('const DAY1_SETUP_DB_RETRY_ATTEMPTS');
    expect(body).toMatch('const DAY1_SETUP_DB_RETRY_SLEEP_MS');
    expect(body).toMatch('setup db retry');
    expect(body).toMatch('const DAY1_RUNTIME_DB_CONNECT_RETRY_ATTEMPTS');
    expect(body).toMatch('const DAY1_RUNTIME_DB_CONNECT_RETRY_SLEEP_MS');
    expect(body).toMatch('const DAY1_LABEL_HTTP_RETRY_ATTEMPTS');
    expect(body).toMatch('const DAY1_LABEL_HTTP_RETRY_SLEEP_MS');
    expect(body).toMatch('const DAY1_LABEL_FAILURE_LOG_LIMIT');
    expect(body).toMatch('const DAY1_ONBOARDING_P95_MS');
    expect(body).toMatch('day1_onboarding_ms: [`p(95)<${DAY1_ONBOARDING_P95_MS}`]');
    expect(body).toMatch('runtime db open retry');
    expect(body).toMatch('label bundle failure sample');
    expect(body).toMatch('const DAY1_TEARDOWN_DB_RETRY_ATTEMPTS');
    expect(body).toMatch('const DAY1_TEARDOWN_DB_RETRY_SLEEP_MS');
    expect(body).toMatch('const DAY1_TEARDOWN_FAIL_ON_MAX_CLIENTS');
    expect(body).toMatch('function isMaxClientsError');
    expect(body).toMatch('function closeCachedConnections');
    expect(body).toMatch('/MaxClientsInSessionMode|max clients reached/i');
    expect(body).toMatch('function runTeardownQueryWithRetry');
    expect(body).toMatch('teardown db retry');
    expect(body).toMatch('teardown cleanup skipped after retries due max-clients saturation');
    expect(body).toMatch('closeCachedConnections();');
    expect(body).toMatch('teardown completed with ${cleanupSkippedStatements} skipped cleanup statement(s)');
    expect(body).toMatch('runTeardownQueryWithRetry(`DELETE FROM public.labels WHERE barcode LIKE $1`');
  });

  test('setup resolves the global row policy once and retains it for iterations', () => {
    const f = loadProfile({ policy: { day1_onboarding_pressure: {
      label_http_retry_attempts: 4, label_http_retry_backoff_ms: 100,
      label_http_retry_backoff_multiplier: 3, label_http_retry_max_sleep_ms: 250,
      label_http_retry_jitter_ms: 0,
    } }, env: { DAY1_LABEL_HTTP_RETRY_ATTEMPTS: '9', DAY1_LABEL_HTTP_RETRY_JITTER_MS: '99' } });
    const data = f.run.setup();
    expect(data.label_pressure_policy).toMatchObject({ label_http_retry_attempts: 4,
      label_http_retry_backoff_ms: 100, label_http_retry_backoff_multiplier: 3,
      label_http_retry_max_sleep_ms: 250, label_http_retry_jitter_ms: 0 });
    expect(f.db.query.mock.calls.filter(([sql]) => sql.includes('AS policy'))).toHaveLength(1);
    expect(f.db.close).toHaveBeenCalledTimes(1);
    const policyLogs = f.log.mock.calls.map(([line]) => line)
      .filter(line => line.startsWith('[day1-load] label_pressure_policy source=global_with_env_fallback '));
    expect(policyLogs).toHaveLength(1);
    expect(JSON.parse(policyLogs[0].slice(policyLogs[0].indexOf('{')))).toEqual(data.label_pressure_policy);
    expect(Object.keys(data.label_pressure_policy)).toHaveLength(6);
    expect(policyLogs[0]).not.toContain('synthetic-private');
  });

  test.each([NaN, Infinity, -1, '', 'not-a-number', true, {}, 1.5])(
    'invalid retry attempts fall back to finite whole attempts: %s', value => {
      const f = loadProfile({ env: { DAY1_LABEL_HTTP_RETRY_ATTEMPTS: '4' } });
      expect(f.run.resolveLabelRetryPolicy({ label_http_retry_attempts: value }).label_http_retry_attempts).toBe(4);
    },
  );

  test('invalid environment numbers use defaults and legacy sleep remains a backoff fallback', () => {
    const f = loadProfile({ env: { DAY1_LABEL_HTTP_RETRY_BACKOFF_MS: 'Infinity',
      DAY1_LABEL_HTTP_RETRY_SLEEP_MS: '350', DAY1_LABEL_HTTP_RETRY_BACKOFF_MULTIPLIER: 'bad',
      DAY1_LABEL_HTTP_RETRY_MAX_SLEEP_MS: 'NaN', DAY1_LABEL_HTTP_RETRY_JITTER_MS: '-1' } });
    expect(f.run.resolveLabelRetryPolicy()).toMatchObject({ label_http_retry_backoff_ms: 350,
      label_http_retry_backoff_multiplier: 2, label_http_retry_max_sleep_ms: 2000, label_http_retry_jitter_ms: 0 });
    expect(f.run.resolveLabelRetryPolicy({ label_http_retry_sleep_ms: 500 }).label_http_retry_backoff_ms).toBe(500);
    expect(f.run.resolveLabelRetryPolicy(null).label_http_retry_attempts).toBe(3);
  });

  test('deterministic jitter is added to exponential backoff and capped', () => {
    const samples = [0, 0.25, 0.5, 0.999];
    const f = loadProfile({ random: () => samples.shift() });
    const policy = f.run.resolveLabelRetryPolicy({ label_http_retry_backoff_ms: 100,
      label_http_retry_backoff_multiplier: 2, label_http_retry_max_sleep_ms: 450, label_http_retry_jitter_ms: 40 });
    expect([1, 2, 3, 4].map(attempt => f.run.computeLabelRetrySleepMs(attempt, policy))).toEqual([100, 210, 420, 450]);
  });

  test.each([false, true])('iteration sleeps only between failures; early success=%s', success => {
    const f = loadProfile({ policy: { day1_onboarding_pressure: {
      label_http_retry_attempts: 3, label_http_retry_backoff_ms: 100,
      label_http_retry_backoff_multiplier: 2, label_http_retry_max_sleep_ms: 150,
    } }, responses: success ? [{ status: 200, body: '{"status":"ok"}' }] : [] });
    f.run.default(f.run.setup());
    expect(f.post).toHaveBeenCalledTimes(success ? 1 : 3);
    expect(f.sleep.mock.calls.map(([seconds]) => seconds)).toEqual(success ? [0.2] : [0.1, 0.15, 0.2]);
  });

  test.each(['environment', 'row'])('caps %s retry attempts at the schema maximum', source => {
    const f = loadProfile({
      env: source === 'environment' ? { DAY1_LABEL_HTTP_RETRY_ATTEMPTS: '1000000' } : {},
      policy: source === 'row' ? { day1_onboarding_pressure: { label_http_retry_attempts: 1000000 } } : {},
    });
    const data = f.run.setup();
    expect(data.label_pressure_policy.label_http_retry_attempts).toBe(10);
    f.run.default(data);
    expect(f.post).toHaveBeenCalledTimes(10);
  });

  test('forward migration adds only optional schema knobs and does not rewrite policy history', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations',
      '20261025004000_label_print_policy_day1_pressure_v1.sql'), 'utf8');
    const schema = JSON.parse(sql.match(/\$schema\$([\s\S]*?)\$schema\$/)[1]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.label_http_retry_jitter_ms).toEqual({ type: 'integer', minimum: 0 });
    expect(schema.properties.label_http_retry_attempts).toEqual({ type: 'integer', minimum: 1, maximum: 10 });
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(loadProfile().run.resolveLabelRetryPolicy()).sort());
    expect(sql).toMatch(/category = 'label_print_policy' AND is_active/);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?settings(?:_versions)?\b/i);
  });
});
