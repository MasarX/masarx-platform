'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { loadExceptions, assessFile } = require('./pgtap-exceptions.cjs');
const { sanitize } = require('./diagnostics.cjs');
const { seconds } = require('./pgtap-timings.json');

// Refresh when the gap between the slowest and fastest pgTAP shards exceeds about 30 s.
// Record per-file median seconds from the durationMs fields in green six-shard pgTAP artifacts.
const weights = new Map(Object.entries(seconds).map(([file, time]) => [file, Math.round(time * 1000)]));
const sortedWeights = [...weights.values()].sort((a, b) => a - b);
const middle = Math.floor(sortedWeights.length / 2);
const medianWeight = sortedWeights.length % 2 ? sortedWeights[middle] : (sortedWeights[middle - 1] + sortedWeights[middle]) / 2;

function shardFiles(files, value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value || '');
  if (!match || +match[1] > +match[2] || +match[2] > 64) throw new Error('Invalid pgTAP shard');
  const names = files.filter(file => file.toLowerCase().endsWith('.sql')).sort();
  if (!names.length || new Set(names).size !== names.length || names.some(file => !/^[a-zA-Z0-9_.-]+\.sql$/i.test(file))) throw new Error('Missing or malformed pgTAP inventory');
  const shards = Array.from({ length: +match[2] }, () => ({ files: [], load: 0 }));
  // Stable sorting keeps file ties alphabetical. The first lightest shard wins load ties.
  const ordered = names.map(file => ({ file, weight: weights.get(file) ?? medianWeight })).sort((a, b) => b.weight - a.weight);
  for (const { file, weight } of ordered) {
    const lightest = shards.reduce((best, shard) => shard.load < best.load ? shard : best);
    lightest.files.push(file);
    lightest.load += weight;
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

async function tests() {
  const runner = require('../tests/run-pgtap-cloud.js');
  const local = require('../ops/ci/cloud-pool-db-local-pgtap.js');
  const entries = loadExceptions();
  const inventory = fs.readdirSync('supabase/tests/pgtap');
  for (const entry of entries) if (!inventory.includes(entry.file)) throw new Error(`stale exception: remove it: missing ${entry.file}`);
  const rows = [];
  await local.runFullPgtap({ projectId: process.env.DB_LOCAL_PROJECT_ID, dbPort: process.env.DB_LOCAL_DB_PORT,
    runSuite: (candidates, full, env) => runner.runSuite(candidates, full, env, {
      assessResult: (file, result) => assessFile(file, result, entries),
      async recordCaseResults(_suite, results) {
        rows.push(...results.map(row => ({ file: row.case_key, status: row.status, durationMs: row.duration_ms, error: sanitize(row.error_summary),
          accepted: row.metadata?.assessment?.accepted || [], assertionFailures: row.metadata?.assessment?.failures || [], exceptionErrors: row.metadata?.assessment?.errors || [] })));
        for (const row of rows.slice(-results.length)) for (const entry of row.accepted) {
          const message = `ACCEPTED (expires ${entry.expires}): ${row.file}: ${entry.assertion}; ${entry.reason}; owner: ${entry.owner}`;
          console.log(message);
          if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`);
        }
        fs.writeFileSync('ci-reports/pgtap-files.json', JSON.stringify(rows, null, 2));
      }, async close() {},
    }),
  });
}
if (require.main === module) tests().catch(error => { console.error(sanitize(error.message)); process.exitCode = 1; });
module.exports = { shardFiles, shardEnvironment, shardResults };
