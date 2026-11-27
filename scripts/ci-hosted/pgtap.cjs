'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadExceptions, assessFile } = require('./pgtap-exceptions.cjs');
const { sanitize } = require('./diagnostics.cjs');
const { seconds, hostedSerialShardLoadFactor } = require('./pgtap-timings.json');

// Refresh when the gap between the slowest and fastest pgTAP shards exceeds about 30 s.
// Record per-file median seconds from the durationMs fields in green six-shard pgTAP artifacts.
const weights = new Map(Object.entries(seconds).map(([file, time]) => [file, Math.round(time * 1000)]));
const sortedWeights = [...weights.values()].sort((a, b) => a - b);
const middle = Math.floor(sortedWeights.length / 2);
const medianWeight = sortedWeights.length % 2 ? sortedWeights[middle] : (sortedWeights[middle - 1] + sortedWeights[middle]) / 2;
const weightOf = file => weights.get(file) ?? medianWeight;
const longestFirst = files => [...files].sort((a, b) => weightOf(b) - weightOf(a));

function shardFiles(files, value, { hosted = false } = {}) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value || '');
  if (!match || +match[1] > +match[2] || +match[2] > 64) throw new Error('Invalid pgTAP shard');
  const names = files.filter(file => file.toLowerCase().endsWith('.sql')).sort();
  if (!names.length || new Set(names).size !== names.length || names.some(file => !/^[a-zA-Z0-9_.-]+\.sql$/i.test(file))) throw new Error('Missing or malformed pgTAP inventory');
  // Hosted shard 1 cannot clone the template database, so each file costs more wall time there.
  const shards = Array.from({ length: +match[2] }, (_, index) => ({
    files: [], load: 0, factor: hosted && index === 0 ? hostedSerialShardLoadFactor : 1,
  }));
  // Stable sorting keeps file ties alphabetical. The first lightest shard wins load ties.
  for (const file of longestFirst(names)) {
    const lightest = shards.reduce((best, shard) => shard.load < best.load ? shard : best);
    lightest.files.push(file);
    lightest.load += weightOf(file) * lightest.factor;
  }
  const selected = shards[+match[1] - 1].files;
  if (!selected.length) throw new Error('Empty pgTAP shard');
  return selected.sort();
}

function shardEnvironment(env, contract, project, dbPort, selected) {
  return { ...env, ...contract, ENV_FILE: os.devNull, ENV_FILE_OVERRIDE: '0', ENV_FILE_APPEND: '0',
    WORKSPACE_NAME: project, DB_LOCAL_PROJECT_ID: project, DB_LOCAL_DB_PORT: String(dbPort),
    PGTAP_ONLY_FILES: selected.join(','), PGTAP_TEST_FILES: '' };
}

function shardResults(selected, files) {
  return { files, run: files.length, passed: files.filter(row => row.status === 'passed').length,
    failed: files.filter(row => row.status === 'failed').length,
    notRun: selected.filter(file => !files.some(row => row.file === file)) };
}

// Inspect the raw text too, so references in PL/pgSQL, SQL strings and comments are pinned.
const sharedState = [
  /\b(?:\w*cron\w*|\w*pg_net\w*|net"?\s*\.|http_(?:get|post|delete|put|head|patch)\b|dblink\w*\b|postgres_fdw\b)/i,
  /\b(?:pg_(?:try_)?advisory_\w+|lock|listen|notify|unlisten|pg_notify|pg_(?:terminate|cancel)_backend|pg_(?:export_snapshot|reload_conf|rotate_logfile|switch_wal))\b/i,
  /['"]postgres['"]|\b(?:current_database|has_database_privilege|pg_database|pg_db_role_setting|pg_authid|pg_auth_members|pg_roles|pg_user|pg_group|pg_shdepend|pg_shdescription|pg_tablespace|pg_settings|pg_locks|pg_stat_\w+|pg_replication_\w+)\b/i,
  /\b(?:(?:create|alter|drop|comment\s+on|security\s+label\s+on)\s+(?:database|role|user|group|tablespace|server|subscription)|alter\s+system|reassign\s+owned|drop\s+owned)\b/i,
  /\b(?:grant|revoke)\s+(?:(?:(?!\bon\b)[^;])*?\b(?:to|from)\b|[^;]*?\bon\s+(?:database|tablespace|parameter)\b)/i,
];
const sqlTrivia = /--[^\n]*|\/\*[\s\S]*?\*\/|\$([a-z_][a-z_0-9]*|)\$[\s\S]*?\$\1\$|'(?:''|[^'])*'/gi;
const transactionEscape = /(?:^|;)\s*(?:commit\b|end\b|abort\b|prepare\s+transaction\b|rollback\b(?!\s+to\b)(?!\s*;$))/i;
const psqlCommand = /^\s*\\|\s\\(?:c|connect|copy|gexec|i|ir|include|include_relative|!)(?=\s|$)/im;

function needsWorkerZero(sql) {
  const statements = sql.replace(sqlTrivia, ' ').trim();
  const body = statements.replace(/^(?:set\s+search_path\s*(?:to\b|=)[\w\s,."]*;\s*)+/i, '');
  return sharedState.some(pattern => pattern.test(sql) || pattern.test(statements)) || psqlCommand.test(sql) || !/^begin\s*;/i.test(body)
    || transactionEscape.test(body) || !/\brollback\s*;$/i.test(body);
}

function hostedBatches(selected, count, readFile = file => fs.readFileSync(path.join('supabase/tests/pgtap', file), 'utf8')) {
  if (count === 1) return { setup: [], serial: [], workers: [selected] };
  const setup = selected.filter(file => file === '00_enable_pgtap.sql');
  const serial = [];
  const parallel = [];
  for (const file of selected) {
    if (setup.includes(file)) continue;
    if (needsWorkerZero(readFile(file))) serial.push(file);
    else parallel.push(file);
  }
  const workers = Array.from({ length: Math.min(count, parallel.length) }, () => ({ files: [], load: 0 }));
  for (const file of longestFirst(parallel)) {
    const worker = workers.reduce((best, row) => row.load < best.load ? row : best);
    worker.files.push(file);
    worker.load += weightOf(file);
  }
  return { setup, serial, workers: workers.map(worker => worker.files) };
}

async function tests() {
  const runner = require('../tests/run-pgtap-cloud.js');
  const local = require('../ops/ci/cloud-pool-db-local-pgtap.js');
  const entries = loadExceptions();
  const inventory = fs.readdirSync('supabase/tests/pgtap');
  for (const entry of entries) if (!inventory.includes(entry.file)) throw new Error(`stale exception: remove it: missing ${entry.file}`);
  const rows = [];
  const group = process.env.PGTAP_HOSTED_GROUP;
  if (group && !/^(setup|worker-0-serial|worker-[0-3])$/.test(group)) throw new Error('Invalid pgTAP worker group');
  const clone = /^worker-([1-3])$/.exec(group || '');
  const qualify = group ? local.runHostedPgtap : local.runFullPgtap;
  const report = group ? `ci-reports/pgtap-${group}.json` : 'ci-reports/pgtap-files.json';
  await qualify({ env: process.env, projectId: process.env.DB_LOCAL_PROJECT_ID, dbPort: process.env.DB_LOCAL_DB_PORT,
    database: clone ? `pgtap_worker_${clone[1]}` : 'postgres',
    runSuite: (candidates, full, env) => runner.runSuite(candidates, full, env, {
      prepareOnly: group === 'setup' && process.env.PGTAP_HOSTED_PREPARE_ONLY === '1',
      prepared: Boolean(group && group !== 'setup'),
      assessResult: (file, result) => assessFile(file, result, entries),
      async recordCaseResults(_suite, results) {
        rows.push(...results.map(row => ({ file: row.case_key, status: row.status, durationMs: row.duration_ms, error: sanitize(row.error_summary),
          accepted: row.metadata?.assessment?.accepted || [], assertionFailures: row.metadata?.assessment?.failures || [], exceptionErrors: row.metadata?.assessment?.errors || [] })));
        for (const row of rows.slice(-results.length)) for (const entry of row.accepted) {
          const message = `ACCEPTED (expires ${entry.expires}): ${row.file}: ${entry.assertion}; ${entry.reason}; owner: ${entry.owner}`;
          console.log(message);
          if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`);
        }
        fs.writeFileSync(report, JSON.stringify(rows, null, 2));
      }, async close() {},
    }),
  });
}
if (require.main === module) tests().catch(error => { console.error(sanitize(error.message)); process.exitCode = 1; });
module.exports = { shardFiles, shardEnvironment, shardResults, hostedBatches, needsWorkerZero };
