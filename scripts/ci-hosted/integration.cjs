'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { shardOption } = require('./jest.cjs');
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

function integrationInventory() {
  return fs.readdirSync(inventoryRoot, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory() && entry.name.endsWith('.test.js'))
    .map(entry => path.join(entry.parentPath, entry.name).split(path.sep).join('/')).sort();
}

function integrationCoverage(shards, inventory, entries) {
  if (!Array.isArray(entries)) throw new Error('Integration exceptions must be a list');
  const expected = new Set(inventory);
  const exceptions = new Map();
  const errors = [];
  for (const entry of entries) {
    if (!expected.has(entry?.file) || exceptions.has(entry.file)
      || ![entry.runner, entry.reason].every(value => typeof value === 'string' && value.trim())
      || (entry.maxSkipped !== undefined && (!Number.isSafeInteger(entry.maxSkipped) || entry.maxSkipped < 0))
      || typeof entry.issue !== 'string' || !/^#[1-9]\d*$/.test(entry.issue)) {
      errors.push(`Invalid or duplicate integration exception: ${entry?.file ?? 'missing file'}`);
    } else {
      exceptions.set(entry.file, entry);
    }
  }
  const seen = new Set();
  const skipped = [];
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
      if (![row.passed, row.skipped].every(value => Number.isSafeInteger(value) && value >= 0)
        || row.failed !== 0 || row.passed + row.skipped === 0) {
        errors.push(`Failed or malformed integration result: ${row.file}`);
      } else if (row.passed > 0) {
        ran++;
        if (exception?.maxSkipped !== undefined && row.skipped > exception.maxSkipped) {
          errors.push(`Additional skipped assertions: ${row.file}`);
        }
      } else if (exception && exception.maxSkipped === undefined) {
        skipped.push(`${row.file} (${exception.issue})`);
      } else {
        errors.push(`Fully skipped without a numbered runner exception: ${row.file}`);
      }
    }
  }
  for (const file of expected) if (!seen.has(file)) errors.push(`Missing integration file: ${file}`);
  return { ok: expected.size > 0 && errors.length === 0, expected: expected.size, seen: seen.size, ran, skipped, errors };
}

async function runIntegration(shard, env, checked, remaining, raw) {
  if (!shardOption(shard)) throw new Error('Missing integration shard');
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
    INTEGRATION_SKIP_FIXTURE_BOOTSTRAP: '0',
    INTEGRATION_INCLUDE_EDGE_DEPENDENT: '1',
    INTEGRATION_JEST_TEST_PATH_IGNORE: '',
    INTEGRATION_JEST_RUN_IN_BAND: '1',
    INTEGRATION_JEST_RETRY_COUNT: '0',
    JEST_RETRY_TIMES: '0',
  };
  let failure;
  try {
    await checked(process.execPath, ['scripts/tests/run-integration-cloud.js', `--shard=${shard}`, '--json', `--outputFile=${raw}`], testEnv, remaining());
  } catch (error) {
    failure = error;
  }
  try {
    const { testResults } = JSON.parse(fs.readFileSync(raw, 'utf8'));
    if (!Array.isArray(testResults) || !testResults.length) throw new Error('Integration Jest reported no files');
    const files = testResults.map(suite => ({
      file: path.relative(process.cwd(), suite.name).split(path.sep).join('/'),
      passed: suite.assertionResults.filter(test => test.status === 'passed').length,
      failed: suite.assertionResults.filter(test => test.status === 'failed').length,
      skipped: suite.assertionResults.filter(test => ['pending', 'todo', 'skipped', 'disabled'].includes(test.status)).length,
    }));
    return { files, failure };
  } catch (error) {
    throw failure ?? error;
  }
}

module.exports = { integrationEdgeEnvironment, integrationInventory, integrationCoverage, exceptionFile, runIntegration };
