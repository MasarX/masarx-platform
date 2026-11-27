'use strict';
const fs = require('node:fs');
const path = require('node:path');

const statuses = ['green', 'red', 'error'];
const shaPattern = /^[0-9a-f]{40}$/;
const exclusions = require('../../config/ci/nightly-out-of-scope.json');

function validExclusion(row) {
  return row != null && ['name', 'reason', 'covered_by'].every(key =>
    typeof row[key] === 'string' && row[key].trim().length > 0);
}

function configuredExclusions(rows = exclusions) {
  if (!Array.isArray(rows) || !rows.every(row => validExclusion(row)
      && (row.flags === undefined || Array.isArray(row.flags) && row.flags.every(flag => /^RUN_[A-Z0-9_]+$/.test(flag)))
      && ['suites', 'files'].every(key => row[key] === undefined ||
        Array.isArray(row[key]) && row[key].every(value => typeof value === 'string' && /^[\w.\/:-]+$/.test(value))))
      || new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('Invalid nightly exclusions');
  return rows;
}

function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isTimestamp(value) {
  const date = new Date(value);
  return typeof value === 'string' && !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function validResult(result) {
  return result != null && isDay(result.date) && statuses.includes(result.status)
    && (typeof result.sha === 'string' && shaPattern.test(result.sha) && result.sha.length === 40
      || result.sha === null && result.status === 'error')
    && isTimestamp(result.started) && isTimestamp(result.finished)
    && result.started.startsWith(result.date) && result.finished >= result.started
    && Array.isArray(result.suites) && result.suites.length <= 100
    && result.suites.every(suite => suite != null && (suite.status === 'out-of-scope' ? validExclusion(suite)
      : typeof suite.name === 'string' && suite.name.length > 0 && suite.name.length <= 120
      && statuses.includes(suite.status) && Array.isArray(suite.failed_tests) && suite.failed_tests.length <= 100
      && (suite.skipped === undefined || Number.isSafeInteger(suite.skipped) && suite.skipped >= 0)
      && suite.failed_tests.every(name => typeof name === 'string' && name.length <= 200)))
    && (result.status !== 'green' || result.suites.some(suite => suite.status === 'green')
      && result.suites.every(suite => suite.status === 'green' || suite.status === 'out-of-scope'));
}

function browserTests(suites) {
  return suites.flatMap(suite => [
    ...(suite.specs || []).flatMap(spec => (spec.tests || []).map(test =>
      ({ file: spec.file || suite.file, name: spec.title, status: test.status }))),
    ...browserTests(suite.suites || []),
  ]);
}

function readSuiteReport(file, excluded = configuredExclusions()) {
  if (!file) return { failedTests: [], skipped: 0, unexplained: 0 };
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(report) && !Array.isArray(report.suites) && !Array.isArray(report.testResults)) {
    throw new Error('Invalid nightly test report');
  }
  const tests = Array.isArray(report) ? report.map(row => ({ ...row, name: row.file }))
    : [...browserTests(report.suites || []), ...(report.suites || report.testResults || []).flatMap(suite =>
      (suite.tests || suite.assertionResults || []).map(test =>
        ({ file: suite.file || suite.name, name: test.fullName, status: test.status })))];
  const names = tests.filter(test => test.status === 'failed' || test.status === 'unexpected').map(test => test.name);
  const skippedTests = tests.filter(test => ['pending', 'skipped', 'todo', 'disabled'].includes(test.status));
  const allowed = new Set(excluded.flatMap(row => row.files || []));
  const explained = skippedTests.filter(test => typeof test.file === 'string'
    && allowed.has((path.isAbsolute(test.file) ? path.relative(process.cwd(), test.file) : test.file).replaceAll('\\', '/'))).length;
  const pending = (report.numPendingTests || 0) + (report.numTodoTests || 0);
  const skipped = Math.max(skippedTests.length, report.skipped || 0, report.stats?.skipped || 0, pending);
  return { failedTests: [...new Set(names.filter(name => typeof name === 'string').map(name => name.slice(0, 200)))].slice(0, 100),
    skipped, unexplained: skipped - explained };
}

const failedTests = file => readSuiteReport(file).failedTests;

function writeResult(file, { sha, started, finished, code, suites }) {
  const status = !sha || suites.some(suite => suite.status === 'error') ? 'error'
    : code !== '0' ? 'red' : 'green';
  const result = { date: started.slice(0, 10), sha: sha || null, status, started, finished, suites };
  if (!validResult(result)) throw new Error('Invalid nightly result');
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  return result;
}

if (require.main === module) {
  const [command, journal, ...args] = process.argv.slice(2);
  if (command === 'record') {
    const [name, initial, report] = args;
    let status = initial;
    let failed_tests = [];
    let skipped = 0;
    try {
      const counts = readSuiteReport(report);
      failed_tests = counts.failedTests;
      skipped = counts.skipped;
      if (status === 'green' && (counts.unexplained || failed_tests.length)) status = 'red';
      if (counts.unexplained) failed_tests = [...failed_tests.slice(0, 99), 'Unexplained skips: ' + counts.unexplained];
    } catch {
      status = 'error';
      failed_tests = ['Missing or invalid test report'];
    }
    fs.appendFileSync(journal, JSON.stringify({ name, status, failed_tests, skipped }) + '\n');
    console.log(status);
  } else if (command === 'finish') {
    const [sha, started, code] = args;
    const suites = fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    suites.push(...configuredExclusions().map(({ name, reason, covered_by }) =>
      ({ name, status: 'out-of-scope', reason, covered_by })));
    writeResult('result.json', { sha, started, code, finished: new Date().toISOString(), suites });
  } else {
    throw new Error('Expected nightly result record or finish');
  }
}

module.exports = { configuredExclusions, failedTests, isDay, readSuiteReport, validResult, writeResult };
