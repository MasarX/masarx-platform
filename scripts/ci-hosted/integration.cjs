'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { shardOption } = require('./jest.cjs');
const timing = require('./integration-timings.json');
const inventoryRoot = 'tests/integration';
const exceptionFile = 'config/ci/hosted-integration-exceptions.json';

function integrationEdgeEnvironment(apiPort) {
  const { buildEdgeDbJwtBundle } = require('../ops/workspace/edge-db-jwt.js');
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw new Error('Invalid local API port');
  const jwtSecret = randomBytes(32).toString('hex');
  const salt = randomBytes(32).toString('hex');
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const origins = [...new Set([apiPort, 3333, 3001])]
    .flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]).join(',');
  const dbJwts = Object.fromEntries(Object.entries(buildEdgeDbJwtBundle({ secret: jwtSecret, ttlSec: 3600 }))
    .map(([name, value]) => [name.toUpperCase(), value]));
  return { jwtSecret, vars: {
    PUBLIC_EDGE_LOCAL_QA_ENABLED: '1',
    PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: origins,
    PUBLIC_INGRESS_LOCAL_CORS_ALLOW_ORIGINS: origins,
    EDGE_SUPABASE_URL: apiUrl,
    EDGE_PUBLIC_SUPABASE_URL: apiUrl,
    MARKETING_IP_HASH_SALT: salt,
    TENANT_SIGNUP_IP_HASH_SALT: salt,
    DRIVER_SIGNUP_IP_HASH_SALT: salt,
    PUBLIC_TRACKING_IP_HASH_SALT: salt,
    MARKETING_TURNSTILE_SECRET_KEY: require('../../supabase/functions/_shared/turnstile-local-test.mjs').LOCAL_MARKETING_TURNSTILE_TEST_SECRET,
    EDGE_REQUIRE_DB_JWT: '1',
    EDGE_INTERNAL_CALLER_ROLES: 'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role,service_role',
    ...dbJwts,
  } };
}

function integrationFunctionConfig() {
  const { loadRegistry, planDeploy } = require('../edge/functions-registry.js');
  // The disposable stack exercises the same public entry points as local development.
  return planDeploy(loadRegistry(), 'dev').noVerifyJwt.flatMap(({ name }) => {
    if (!/^[a-z0-9_-]+$/.test(name)) throw new Error('Invalid hosted Edge function name');
    return ['[functions.' + name + ']', 'verify_jwt = false'];
  });
}

function integrationShards(inventory, { jobs, seconds, fallbackSeconds, jobBudgetSeconds, workflowBudgetSeconds, tailSeconds } = timing) {
  const weight = file => seconds[file] ?? fallbackSeconds;
  const shards = jobs.map(({ baseSeconds, startSeconds }) => ({ load: baseSeconds, startSeconds, files: [] }));
  const cost = (shard, file) => Math.max(
    (shard.load + weight(file)) / jobBudgetSeconds,
    (shard.startSeconds + shard.load + weight(file)) / (workflowBudgetSeconds - tailSeconds),
  );
  for (const file of [...inventory].sort().sort((a, b) => weight(b) - weight(a))) {
    const shard = shards.reduce((best, row) => cost(row, file) < cost(best, file) ? row : best);
    shard.files.push(file);
    shard.load += weight(file);
  }
  return shards.map(shard => shard.files.sort());
}

function integrationInventory() {
  return fs.readdirSync(inventoryRoot, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory() && entry.name.endsWith('.test.js'))
    .map(entry => path.join(entry.parentPath, entry.name).split(path.sep).join('/')).sort();
}

function integrationCoverage(shards, inventory, entries, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(entries)) throw new Error('Integration exceptions must be a list');
  const expected = new Set(inventory);
  const exceptions = new Map();
  const errors = [];
  for (const entry of entries) {
    const knownFailure = entry?.kind === 'known-failure';
    const expiry = typeof entry?.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.expires)
      ? new Date(entry.expires + 'T00:00:00Z') : null;
    if (!expected.has(entry?.file) || exceptions.has(entry.file)
      || ![entry.runner, entry.reason].every(value => typeof value === 'string' && value.trim())
      || (entry.maxSkipped !== undefined && (!Number.isSafeInteger(entry.maxSkipped) || entry.maxSkipped < 0))
      || (entry.kind !== undefined && !knownFailure)
      || (knownFailure ? !expiry || Number.isNaN(+expiry) || expiry.toISOString().slice(0, 10) !== entry.expires
        || entry.expires > '2026-12-08' || entry.maxSkipped !== undefined : entry.expires !== undefined)
      || typeof entry.issue !== 'string' || !/^#[1-9]\d*$/.test(entry.issue)) {
      errors.push(`Invalid or duplicate integration exception: ${entry?.file ?? 'missing file'}`);
    } else if (knownFailure && entry.expires < today) {
      errors.push('Expired integration exception: ' + entry.file + ' (' + entry.issue + ')');
    } else {
      exceptions.set(entry.file, entry);
    }
  }
  const seen = new Set();
  const skipped = [];
  const knownFailures = [];
  let ran = 0;
  for (const shard of shards) {
    if (!Array.isArray(shard.integrationFiles) || !shard.integrationFiles.length) {
      errors.push(`Incomplete integration report for shard ${shard.shard}`);
      continue;
    }
    if (shard.integration !== 'passed') errors.push(`Integration shard ${shard.shard} failed`);
    for (const row of shard.integrationFiles) {
      if (!expected.has(row?.file) || seen.has(row.file)) {
        errors.push(`Unexpected or duplicate integration file: ${row?.file ?? 'missing file'}`);
        continue;
      }
      seen.add(row.file);
      const exception = exceptions.get(row.file);
      if (![row.passed, row.failed, row.skipped].every(value => Number.isSafeInteger(value) && value >= 0)
        || row.passed + row.failed + row.skipped === 0) {
        errors.push('Malformed integration result: ' + row.file);
      } else if (row.failed > 0) {
        ran++;
        if (exception?.kind === 'known-failure' && row.skipped === 0) {
          knownFailures.push(row.file + ' (' + exception.issue + ', expires ' + exception.expires + ')');
        } else {
          errors.push('Unlisted integration failure or skipped assertions: ' + row.file);
        }
      } else if (exception?.kind === 'known-failure') {
        errors.push('Stale integration exception: ' + row.file);
      } else if (row.passed > 0) {
        ran++;
        if (row.skipped === 0 && exception) {
          errors.push(`Stale integration exception: ${row.file}`);
        } else if (row.skipped > 0 && (exception?.maxSkipped === undefined || row.skipped > exception.maxSkipped)) {
          errors.push(`Unexpected skipped assertions: ${row.file} (${row.skipped})`);
        }
      } else if (exception && exception.maxSkipped === undefined) {
        skipped.push(`${row.file} (${exception.issue})`);
      } else {
        errors.push(`Fully skipped without a numbered runner exception: ${row.file}`);
      }
    }
  }
  for (const file of expected) if (!seen.has(file)) errors.push(`Missing integration file: ${file}`);
  return { ok: expected.size > 0 && errors.length === 0, expected: expected.size, seen: seen.size, ran, skipped, knownFailures, errors };
}

async function restoreIntegrationDatabase(admin, wait = delay) {
  const reloaded = await admin('ALTER SYSTEM RESET autovacuum', 'ALTER SYSTEM RESET cron.launch_active_jobs', 'SELECT pg_reload_conf()');
  if (reloaded.trim() !== 't') throw new Error('Could not reload the integration database configuration');
  for (let attempt = 0; attempt < 20; attempt++) {
    const settings = JSON.parse(await admin(`SELECT json_build_object(
      'autovacuum', current_setting('autovacuum'), 'cron', current_setting('cron.launch_active_jobs'))`));
    if (settings.autovacuum === 'on' && settings.cron === 'on') return settings;
    if (attempt < 19) await wait(250);
  }
  throw new Error('Integration database did not restore autovacuum and pg_cron launches');
}

function integrationShardFiles(shard, inventory = integrationInventory()) {
  if (!shardOption(shard)) throw new Error('Missing integration shard');
  const [index, count] = shard.split('/').map(Number);
  const files = integrationShards(inventory);
  if (files.length !== count || !files[index - 1]?.length) throw new Error('Invalid hosted integration shard inventory');
  return files[index - 1];
}

async function runIntegration(selected, env, checked, remaining, raw) {
  const testEnv = {
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
    TEST_FIXTURE_MUTATION_MODE: 'local',
    RUN_EDGE_E2E: 'true',
    RUN_LOCAL_EDGE_TESTS: 'true',
    RUN_API_GATEWAY_HTTP_TESTS: 'true',
    RUN_WEBHOOK_HTTP_TESTS: 'true',
    RUN_LABELS_WEBHOOK_TESTS: 'true',
    RUN_RLS_INTEGRATION_TESTS: 'true',
    RUN_MATRIX_E2E: 'true',
    RUN_LIVE_3PL_TESTS: 'false',
    RUN_LIVE_COMMS_TESTS: 'false',
    RUN_LIVE_GEOCODING_TESTS: 'false',
    RUN_LIVE_PITCH_TESTS: 'false',
    RUN_LIVE_WEBHOOK_TESTS: 'true',
    RUN_SHIPMENTS_PRINT_BENCHMARK_TEST: 'false',
    API_CALLER_GUARDED_EGRESS_PROOF_LANE: '',
    INTEGRATION_SKIP_EDGE_SHARED_SYNC: '1',
    INTEGRATION_AUTO_ENABLE_TEST_TOGGLES: '0',
    INTEGRATION_SKIP_FIXTURE_BOOTSTRAP: '0',
    INTEGRATION_INCLUDE_EDGE_DEPENDENT: '1',
    INTEGRATION_JEST_TEST_PATH_IGNORE: '',
    INTEGRATION_JEST_RUN_IN_BAND: '1',
    INTEGRATION_JEST_RETRY_COUNT: '0',
    JEST_RETRY_TIMES: '0',
  };
  let failure;
  try {
    await checked(process.execPath, ['scripts/tests/run-integration-cloud.js', '--json', '--outputFile=' + raw, '--runTestsByPath', ...selected], testEnv, remaining());
  } catch (error) {
    failure = error;
  }
  try {
    const report = JSON.parse(fs.readFileSync(raw, 'utf8'));
    if (report.wasInterrupted !== false || !Array.isArray(report.testResults) || !report.testResults.length) {
      throw new Error('Integration Jest reported no complete results');
    }
    const files = report.testResults.map(suite => ({
      file: path.relative(process.cwd(), suite.name).split(path.sep).join('/'),
      passed: suite.assertionResults.filter(test => test.status === 'passed').length,
      failed: Math.max(suite.assertionResults.filter(test => test.status === 'failed').length,
        Number(suite.status === 'failed' || Boolean(suite.failureMessage || suite.testExecError || suite.message))),
      skipped: suite.assertionResults.filter(test => ['pending', 'todo', 'skipped', 'disabled'].includes(test.status)).length,
      durationMs: Math.max(0, suite.endTime - suite.startTime) || 0,
    }));
    const failed = files.filter(file => file.failed > 0).length;
    // Only a completed Jest report can explain exit 1. Startup and timeout errors still fail the shard.
    if (report.snapshot?.failure || report.snapshot?.unchecked
      || report.numFailedTestSuites !== failed || report.success !== (failed === 0)
      || (failed ? failure?.failure?.exitCode !== 1 || failure.failure.timeout || failure.failure.signal : failure)) {
      throw new Error('Integration Jest exit does not match the reported suites');
    }
    return files;
  } catch (error) {
    throw failure ?? error;
  }
}

module.exports = { integrationEdgeEnvironment, integrationFunctionConfig, integrationInventory, integrationShards, integrationShardFiles, integrationCoverage, exceptionFile, restoreIntegrationDatabase, runIntegration };
