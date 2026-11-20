const fs = require('fs');
const path = require('path');

describe('run-load-test config', () => {
  test('supports docker timeout env overrides', () => {
    const file = path.join(__dirname, '..', '..', 'scripts', 'qa', 'run-load-test.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('LOAD_TEST_DOCKER_MODE');
    expect(body).toMatch('LOAD_TEST_DOCKER_CHECK_TIMEOUT_MS');
    expect(body).toMatch('LOAD_TEST_DOCKER_TIMEOUT_MS');
  });

  test('allows workflow-selected local xk6 fallback on dockerless CI lanes', () => {
    const file = path.join(__dirname, '..', '..', 'scripts', 'qa', 'run-load-test.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('RUNNER_ENVIRONMENT');
    expect(body).toMatch('Docker is required for this run but is not available.');
    expect(body).toMatch('Docker usage disabled by policy; using local xk6 fallback.');
    expect(body).toMatch('Docker not available; using local xk6 fallback.');
    expect(body).toMatch('xk6_build_failed');
    expect(body).toMatch('scenario_failed');
  });

  test('passes partition cleanup control through to k6', () => {
    const file = path.join(__dirname, '..', '..', 'scripts', 'qa', 'run-load-test.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('PARTITION_CLEANUP');
  });

  test('prefers DATABASE_URL with hostaddr in auto mode for docker-safe connectivity', () => {
    const file = path.join(__dirname, '..', '..', 'scripts', 'qa', 'run-load-test.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('DATABASE_URL(hostaddr)');
    expect(body).toMatch('Using DATABASE_URL with hostaddr for load tests');
  });

  test('uses isolated DOCKER_CONFIG when none is provided', () => {
    const file = path.join(__dirname, '..', '..', 'scripts', 'qa', 'run-load-test.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('docker-authless');
    expect(body).toMatch('Using isolated DOCKER_CONFIG');
  });

  test('exposes day1 onboarding pressure scenario and env knobs', () => {
    const file = path.join(__dirname, '..', '..', 'scripts', 'qa', 'run-load-test.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('day1-onboarding-pressure');
    expect(body).toMatch('LABEL_RENDERER_DB_JWT');
    expect(body).toMatch('LOAD_TEST_DAY1_VALIDATE_LABEL_JWT');
    expect(body).toMatch('LOAD_TEST_DAY1_ENSURE_STORAGE_BUCKETS');
    expect(body).toMatch('ensure-storage-buckets.js');
    expect(body).toMatch('edge_label_renderer_role');
    expect(body).toMatch('DAY1_PROFILE');
    expect(body).toMatch('DAY1_TENANTS');
    expect(body).toMatch('DAY1_LABEL_REQUEST_RATE');
    expect(body).toMatch('DAY1_LABEL_HTTP_RETRY_ATTEMPTS');
    expect(body).toMatch('DAY1_LABEL_HTTP_RETRY_SLEEP_MS');
    for (const knob of ['BACKOFF_MS', 'BACKOFF_MULTIPLIER', 'MAX_SLEEP_MS', 'JITTER_MS']) {
      expect(body.match(new RegExp("'DAY1_LABEL_HTTP_RETRY_" + knob + "'", 'g'))).toHaveLength(2);
    }
    expect(body).toMatch('DAY1_LABEL_FAILURE_LOG_LIMIT');
  });
});
