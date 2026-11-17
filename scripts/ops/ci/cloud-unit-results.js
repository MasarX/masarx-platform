'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function junit(results, errors = []) {
  const suites = results.flatMap(result => result.testResults || []).filter(suite => suite && typeof suite === 'object').map(suite => {
    const cases = Array.isArray(suite.assertionResults) ? suite.assertionResults.filter(test => test && typeof test === 'object') : [];
    const failures = cases.filter(test => test.status === 'failed').length;
    const runtimeError = suite.status === 'failed' && failures === 0;
    const skipped = cases.filter(test => ['pending', 'todo', 'disabled'].includes(test.status)).length;
    const body = cases.map(test => {
      const detail = test.status === 'failed' ? `<failure>${xml(Array.isArray(test.failureMessages) ? test.failureMessages.join('\n') : test.failureMessages)}</failure>`
        : test.status === 'passed' ? '' : '<skipped/>';
      return `<testcase classname="${xml(suite.name)}" name="${xml(test.fullName)}" time="${(test.duration || 0) / 1000}">${detail}</testcase>`;
    });
    if (runtimeError) body.push(`<testcase name="suite execution"><error>${xml(suite.message)}</error></testcase>`);
    return `<testsuite name="${xml(suite.name)}" tests="${cases.length + Number(runtimeError)}" failures="${failures}" errors="${Number(runtimeError)}" skipped="${skipped}" time="${Math.max(0, (suite.endTime || 0) - (suite.startTime || 0)) / 1000}">${body.join('')}</testsuite>`;
  });
  if (errors.length) suites.push(`<testsuite name="shard integrity" tests="${errors.length}" failures="${errors.length}">${errors.map(error => `<testcase name="result contract"><failure>${xml(error)}</failure></testcase>`).join('')}</testsuite>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>${suites.join('')}</testsuites>\n`;
}

function relativeFile(file, workspace) {
  assert.equal(typeof file, 'string', 'test file must be a string');
  const relative = path.relative(workspace, file).split(path.sep).join('/');
  assert.ok(relative.startsWith('tests/unit/') && !relative.split('/').includes('..'), `invalid unit file: ${file}`);
  return relative;
}

function shardCount(value) {
  assert.ok(value === '1' || value === '4', 'expected shard count must be 1 or 4');
  return Number(value);
}

function recordShard(directory, shard, env = process.env, workspace = process.cwd()) {
  const count = shardCount(env.UNIT_SHARD_COUNT);
  assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= count, 'invalid shard');
  const result = readJson(path.join(directory, `jest-${shard}.json`));
  const files = readJson(path.join(directory, `expected-files-${shard}.json`));
  assert.ok(Array.isArray(files) && files.length > 0, 'empty expected file manifest');
  const expectedFiles = files.map(file => relativeFile(file, workspace)).sort();
  result.testResults.forEach(suite => { suite.name = relativeFile(suite.name, workspace); });
  const summary = {
    shard, count, sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT, outcome: env.SHARD_OUTCOME, expectedFiles, result,
  };
  writeJson(path.join(directory, `shard-${shard}.json`), summary);
  fs.writeFileSync(path.join(directory, `junit-${shard}.xml`), junit([result]));
  return summary;
}

function validateShard(summary, shard, count, env) {
  assert.equal(summary.shard, shard, 'shard identity mismatch');
  assert.equal(summary.count, count, 'shard count mismatch');
  for (const [key, variable] of [['sha', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'], ['attempt', 'GITHUB_RUN_ATTEMPT']]) {
    assert.ok(env[variable], `missing ${variable}`);
    assert.equal(summary[key], env[variable], `${key} mismatch`);
  }
  assert.equal(summary.outcome, 'success', `shard ${shard} outcome is ${summary.outcome}`);
  const { result, expectedFiles } = summary;
  assert.ok(Array.isArray(expectedFiles) && expectedFiles.length > 0, 'empty expected file manifest');
  assert.equal(new Set(expectedFiles).size, expectedFiles.length, 'duplicate manifest file');
  for (const file of expectedFiles) {
    assert.ok(typeof file === 'string' && file.startsWith('tests/unit/') && !file.split('/').includes('..'), 'invalid manifest file');
  }
  assert.equal(result.success, true, `shard ${shard} Jest failed`);
  assert.equal(result.wasInterrupted, false, 'interrupted Jest run');
  assert.equal(result.numFailedTestSuites, 0, 'failed test suites');
  assert.equal(result.numRuntimeErrorTestSuites, 0, 'runtime error suites');
  assert.equal(result.numFailedTests, 0, 'failed tests');
  assert.equal(result.numTotalTestSuites, result.testResults.length, 'suite totals do not reconcile');
  assert.equal(result.numTotalTestSuites, result.numPassedTestSuites + result.numPendingTestSuites, 'suite status totals do not reconcile');
  const counts = { passed: 0, pending: 0, todo: 0, failed: 0 };
  const suites = { passed: 0, focused: 0, skipped: 0 };
  for (const suite of result.testResults) {
    assert.ok(Object.hasOwn(suites, suite.status), 'invalid suite status');
    suites[suite.status] += 1;
    for (const test of suite.assertionResults) {
      assert.ok(Object.hasOwn(counts, test.status), 'invalid test status');
      counts[test.status] += 1;
    }
  }
  assert.equal(suites.passed + suites.focused, result.numPassedTestSuites, 'passed suite total mismatch');
  assert.equal(suites.skipped, result.numPendingTestSuites, 'pending suite total mismatch');
  for (const [status, field] of [['passed', 'numPassedTests'], ['pending', 'numPendingTests'], ['todo', 'numTodoTests'], ['failed', 'numFailedTests']]) {
    assert.equal(counts[status], result[field], `${field} does not reconcile`);
  }
  assert.equal(result.numTotalTests, Object.values(counts).reduce((sum, count) => sum + count, 0), 'test totals do not reconcile');
}

function aggregate(directory, outputFile, env = process.env) {
  // The workflow's route is authoritative; artifact claims cannot shrink the required union.
  const count = shardCount(env.EXPECTED_UNIT_SHARDS);
  const errors = [];
  const results = [];
  const observed = [];
  let expected;
  if (env.UNIT_SHARDS_RESULT !== 'success') errors.push(`matrix outcome is ${env.UNIT_SHARDS_RESULT || 'missing'}`);
  try {
    const records = fs.readdirSync(directory).filter(name => /^shard-.*\.json$/.test(name)).sort();
    assert.ok(records.length === count && records.every((name, index) => name === `shard-${index + 1}.json`),
      `expected exactly ${count} shard records`);
  } catch (error) {
    errors.push(error.message);
  }
  for (let shard = 1; shard <= count; shard += 1) {
    try {
      const summary = readJson(path.join(directory, `shard-${shard}.json`));
      if (Array.isArray(summary.result?.testResults)) results.push(summary.result);
      validateShard(summary, shard, count, env);
      const files = [...summary.expectedFiles].sort();
      if (expected) assert.deepEqual(files, expected, 'expected file manifests differ');
      else expected = files;
      observed.push(...summary.result.testResults.map(suite => suite.name));
    } catch (error) {
      errors.push(`shard ${shard}: ${error.message}`);
    }
  }
  if (expected) {
    if (new Set(observed).size !== observed.length) errors.push('duplicate executed test files');
    if (JSON.stringify([...observed].sort()) !== JSON.stringify(expected)) errors.push('executed file union does not match expected file manifest');
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, junit(results, errors));
  if (errors.length) throw new Error(errors.join('\n'));
  return { shards: count, files: observed.length, tests: results.reduce((sum, result) => sum + result.numTotalTests, 0) };
}

if (require.main === module) {
  try {
    const [mode, directory, value] = process.argv.slice(2);
    if (mode === 'shard') recordShard(directory, Number(value));
    else if (mode === 'aggregate') console.log(JSON.stringify(aggregate(directory, value)));
    else throw new Error('usage: cloud-unit-results.js shard <directory> <index> | aggregate <directory> <junit.xml>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { recordShard, aggregate, junit };
