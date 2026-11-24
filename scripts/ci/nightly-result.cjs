'use strict';
const fs = require('node:fs');

const statuses = ['green', 'red', 'error'];
const shaPattern = /^[0-9a-f]{40}$/;
const exclusions = require('../../config/ci/nightly-out-of-scope.json');

function validExclusion(row) {
  return row != null && ['name', 'reason', 'covered_by'].every(key =>
    typeof row[key] === 'string' && row[key].trim().length > 0);
}

function configuredExclusions(rows = exclusions) {
  if (!Array.isArray(rows) || !rows.every(row => validExclusion(row)
      && (row.flags === undefined || Array.isArray(row.flags) && row.flags.every(flag => /^RUN_LIVE_[A-Z0-9_]+$/.test(flag))))
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
      && suite.failed_tests.every(name => typeof name === 'string' && name.length <= 200)))
    && (result.status !== 'green' || result.suites.some(suite => suite.status === 'green')
      && result.suites.every(suite => suite.status === 'green' || suite.status === 'out-of-scope'));
}

function browserFailures(suites) {
  return suites.flatMap(suite => [
    ...(suite.specs || []).filter(spec => spec.tests?.some(test => test.status === 'unexpected')).map(spec => spec.title),
    ...browserFailures(suite.suites || []),
  ]);
}

function failedTests(file) {
  if (!file || !fs.existsSync(file)) return [];
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = Array.isArray(report)
    ? report.filter(row => row.status === 'failed').map(row => row.file)
    : [...browserFailures(report.suites || []), ...(report.suites || report.testResults || []).flatMap(suite =>
      (suite.tests || suite.assertionResults || []).filter(test => test.status === 'failed')
        .map(test => test.fullName))];
  return [...new Set(names.filter(name => typeof name === 'string').map(name => name.slice(0, 200)))].slice(0, 100);
}

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
    const [name, status, report] = args;
    const failed_tests = status === 'green' ? [] : failedTests(report);
    fs.appendFileSync(journal, JSON.stringify({ name, status, failed_tests }) + '\n');
  } else if (command === 'flags') {
    console.log(configuredExclusions().flatMap(row => row.flags || []).join('\n'));
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

module.exports = { configuredExclusions, failedTests, isDay, validResult, writeResult };
