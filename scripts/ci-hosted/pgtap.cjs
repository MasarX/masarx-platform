'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { sanitize } = require('./diagnostics.cjs');

function shardFiles(files, value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value || '');
  if (!match || +match[1] > +match[2] || +match[2] > 64) throw new Error('Invalid pgTAP shard');
  const names = files.filter(file => file.toLowerCase().endsWith('.sql')).sort();
  if (!names.length || new Set(names).size !== names.length || names.some(file => !/^[a-zA-Z0-9_.-]+\.sql$/i.test(file))) throw new Error('Missing or malformed pgTAP inventory');
  const selected = names.filter((_, index) => index % +match[2] === +match[1] - 1);
  if (!selected.length) throw new Error('Empty pgTAP shard');
  return selected;
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
  const rows = [];
  await local.runFullPgtap({ projectId: process.env.DB_LOCAL_PROJECT_ID, dbPort: process.env.DB_LOCAL_DB_PORT,
    runSuite: (candidates, full, env) => runner.runSuite(candidates, full, env, {
      async recordCaseResults(_suite, results) {
        rows.push(...results.map(row => ({ file: row.case_key, status: row.status, durationMs: row.duration_ms, error: sanitize(row.error_summary) })));
        fs.writeFileSync('ci-reports/pgtap-files.json', JSON.stringify(rows, null, 2));
      }, async close() {},
    }),
  });
}
if (require.main === module) tests().catch(error => { console.error(sanitize(error.message)); process.exitCode = 1; });
module.exports = { shardFiles, shardEnvironment, shardResults };
