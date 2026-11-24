'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { integrationCoverage, integrationFunctionConfig, integrationInventory, integrationShards,
  restoreIntegrationDatabase, runIntegration } = require('./integration.cjs');
const { loadRegistry, planDeploy } = require('../edge/functions-registry.js');
const timing = require('./integration-timings.json');

test('the required database workflow checks integration coverage by default', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/public-ci.yml'), 'utf8');
  const gate = /^      - name: Require database build and complete shard coverage\r?\n((?: {8}[^\r\n]*\r?\n)+)/m.exec(workflow)?.[1];
  assert.ok(gate, 'Missing the required database result step');
  assert.match(gate, /^          HOSTED_INTEGRATION_REQUIRED: 'true'\r?$/m);
  assert.match(gate, /^        run: node scripts\/ci-hosted\/database-result\.cjs\r?$/m);
});

test('accounts for exactly one result per integration file and requires a numbered skip exception', () => {
  const fixture = randomUUID();
  const inventory = Array.from({ length: 6 }, (_, index) => `tests/integration/${fixture}-${index}.test.js`);
  const shards = inventory.map((file, index) => ({
    shard: `${index + 1}/6`, integration: 'passed', integrationFiles: [{ file, passed: 1, failed: 0, skipped: 0 }],
  }));
  assert.equal(integrationCoverage(shards, inventory, []).ok, true);
  assert.match(integrationCoverage(shards.slice(1), inventory, []).errors[0], /Missing integration file/);
  assert.match(integrationCoverage([...shards, shards[0]], inventory, []).errors[0], /duplicate integration file/);

  Object.assign(shards[0].integrationFiles[0], { passed: 0, skipped: 1 });
  const exception = { file: inventory[0], runner: 'Synthetic runner', reason: 'Requires fixture setup' };
  assert.match(integrationCoverage(shards, inventory, [{ ...exception, issue: 'TBD' }]).errors.join('\n'), /Fully skipped without a numbered/);
  const accepted = { ...exception, issue: '#1' };
  assert.equal(integrationCoverage(shards, inventory, [accepted]).ok, true);
  const partial = { ...accepted, maxSkipped: 1 };
  assert.equal(integrationCoverage(shards, inventory, [partial]).ok, false);
  shards[0].integrationFiles[0].passed = 1;
  assert.match(integrationCoverage(shards, inventory, []).errors[0], /Unexpected skipped assertions/);
  assert.equal(integrationCoverage(shards, inventory, [partial]).ok, true);
  shards[0].integrationFiles[0].skipped = 0;
  assert.match(integrationCoverage(shards, inventory, [partial]).errors[0], /Stale integration exception/);
  shards[0].integrationFiles[0].skipped = 2;
  assert.equal(integrationCoverage(shards, inventory, [partial]).ok, false);
  shards[0].integrationFiles[0].failed = 1;
  assert.equal(integrationCoverage(shards, inventory, [accepted]).ok, false);
});

test('releases the pgTAP database maintenance holds before integration', async () => {
  const reads = [{ autovacuum: 'on', cron: 'off' }, { autovacuum: 'on', cron: 'on' }];
  const admin = async (...commands) => {
    if (commands.length > 1) {
      assert.deepEqual(commands, ['ALTER SYSTEM RESET autovacuum', 'ALTER SYSTEM RESET cron.launch_active_jobs', 'SELECT pg_reload_conf()']);
      return 't';
    }
    assert.match(commands[0], /current_setting\('autovacuum'\).*current_setting\('cron\.launch_active_jobs'\)/);
    return JSON.stringify(reads.shift());
  };
  const waits = [];
  assert.deepEqual(await restoreIntegrationDatabase(admin, ms => waits.push(ms)), { autovacuum: 'on', cron: 'on' });
  assert.deepEqual(waits, [250]);
  await assert.rejects(restoreIntegrationDatabase(async () => 'f'), /Could not reload/);
});

test('renders JWT overrides only for public functions enabled in the development registry', () => {
  const { noVerifyJwt } = planDeploy(loadRegistry(), 'dev');
  assert.deepEqual(integrationFunctionConfig(), noVerifyJwt.flatMap(({ name }) => [
    '[functions.' + name + ']', 'verify_jwt = false',
  ]));
  assert.ok(integrationFunctionConfig().includes('[functions.webhook-receiver]'));
  assert.ok(!integrationFunctionConfig().includes('[functions.label-renderer]'));
});

test('assigns all discovered files once using stable duration-weighted shards', () => {
  const inventory = integrationInventory();
  const shards = integrationShards(inventory);
  assert.equal(shards.length, timing.jobs.length);
  assert.ok(shards.every(files => files.length));
  assert.deepEqual(shards.flat().sort(), inventory);
  assert.deepEqual(integrationShards([...inventory].reverse()), shards);

  const files = ['slow.test.js', 'quick.test.js', 'new.test.js'];
  const sample = { ...timing, seconds: { 'slow.test.js': 100, 'quick.test.js': 1 },
    jobs: [{ baseSeconds: 90, startSeconds: 0 }, { baseSeconds: 10, startSeconds: 0 }] };
  assert.deepEqual(integrationShards(files, sample), [['new.test.js', 'quick.test.js'], ['slow.test.js']]);
});

test('accepts only current, numbered known failures and rejects stale entries', () => {
  const file = 'tests/integration/synthetic.test.js';
  const result = { file, passed: 3, failed: 1, skipped: 0 };
  const shards = [{ shard: '1/6', integration: 'passed', integrationFiles: [result] }];
  const entry = { file, kind: 'known-failure', runner: 'Hosted integration',
    reason: 'Synthetic teardown failure', issue: '#1', expires: '2026-12-08' };
  const verdict = (entries, day = '2026-12-08') => integrationCoverage(shards, [file], entries, day);
  assert.equal(verdict([entry]).ok, true);
  assert.deepEqual(verdict([entry]).knownFailures, [file + ' (#1, expires 2026-12-08)']);
  assert.match(verdict([]).errors[0], /Unlisted integration failure/);
  assert.match(verdict([entry], '2026-12-09').errors[0], /Expired integration exception/);
  assert.match(verdict([{ ...entry, expires: '2026-12-10' }]).errors[0], /Invalid.*integration exception/);
  result.skipped = 1;
  assert.equal(verdict([entry]).ok, false);
  result.skipped = 0;
  result.failed = 0;
  assert.match(verdict([entry]).errors[0], /Stale integration exception/);
});

test('counts suite-level teardown failures from the single cloud wrapper attempt', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-result-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const raw = path.join(folder, 'result.json');
  const file = `tests/integration/${randomUUID()}.test.js`;
  const failure = Object.assign(new Error('Synthetic test failed'), { failure: { exitCode: 1 } });
  const report = { wasInterrupted: false, numFailedTestSuites: 1, success: false, testResults: [{
    name: path.resolve(file), status: 'failed', message: 'Synthetic afterAll failure', startTime: 10, endTime: 20,
    assertionResults: [{ status: 'passed' }],
  }] };
  const invoke = () => runIntegration([file], {}, async (command, args, env, timeout) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['scripts/tests/run-integration-cloud.js', '--json', '--outputFile=' + raw, '--runTestsByPath', file]);
    assert.equal(env.INTEGRATION_JEST_RETRY_COUNT, '0');
    assert.equal(env.INTEGRATION_AUTO_ENABLE_TEST_TOGGLES, '0');
    assert.equal(env.RUN_LIVE_3PL_TESTS, 'false');
    assert.equal(timeout, 1234);
    fs.writeFileSync(raw, JSON.stringify(report));
    throw failure;
  }, () => 1234, raw);
  assert.deepEqual(await invoke(), [{ file, passed: 1, skipped: 0, failed: 1, durationMs: 10 }]);
  failure.failure.timeout = true;
  await assert.rejects(invoke, failure);
  failure.failure.timeout = false;
  report.wasInterrupted = true;
  await assert.rejects(invoke, failure);
});
