'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { integrationCoverage, runIntegration } = require('./integration.cjs');

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
  assert.equal(integrationCoverage(shards, inventory, [partial]).ok, true);
  shards[0].integrationFiles[0].skipped = 2;
  assert.equal(integrationCoverage(shards, inventory, [partial]).ok, false);
  shards[0].integrationFiles[0].failed = 1;
  assert.equal(integrationCoverage(shards, inventory, [accepted]).ok, false);
});

test('retains file results from the single cloud wrapper attempt', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-result-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const raw = path.join(folder, 'result.json');
  const file = `tests/integration/${randomUUID()}.test.js`;
  const failure = new Error('Synthetic test failed');
  const observed = await runIntegration('2/6', {}, async (command, args, env, timeout) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['scripts/tests/run-integration-cloud.js', '--shard=2/6', '--json', `--outputFile=${raw}`]);
    assert.equal(env.INTEGRATION_JEST_RETRY_COUNT, '0');
    assert.equal(env.RUN_LIVE_3PL_TESTS, 'false');
    assert.equal(timeout, 1234);
    fs.writeFileSync(raw, JSON.stringify({ testResults: [{ name: path.resolve(file), assertionResults: [{ status: 'failed' }] }] }));
    throw failure;
  }, () => 1234, raw);
  assert.deepEqual(observed, { files: [{ file, passed: 0, skipped: 0, failed: 1 }], failure });
});
