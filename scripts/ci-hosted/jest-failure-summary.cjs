'use strict';
const fs = require('node:fs');
const { sanitize } = require('./diagnostics.cjs');
const { parseEntries, retainedEntries, shardOption } = require('./jest.cjs');
const { targetFile } = require('./target-policy.cjs');

const MAX_FAILURES = 10;
const MAX_NAME_LENGTH = 180;
const BASELINE = 'config/ci/known-failures.txt';
const RUN_ARTIFACT = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/artifacts\/\d+$/;
const PRIVATE_TITLE = /(?:\b[a-z][a-z\d+.-]*:\/\/|\b(?:[\w-]+\.)+[a-z][\w-]*\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*|(?:^|[^\w])(?:[a-z]:[\\/]|\\\\|\/)|\b(?:host(?:name)?|server)\s*[:=]\s*['"]?[\w-]+)/i;

function displayName(value) {
  const line = sanitize(value).normalize('NFKC').replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (PRIVATE_TITLE.test(line)) return '[name redacted]';
  const bounded = Array.from(line).slice(0, MAX_NAME_LENGTH).join('') || '[name unavailable]';
  return bounded.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function unexpectedFailures(report, lane) {
  const retained = report.expected ? retainedEntries(
    parseEntries(targetFile(BASELINE, report.baselineSource), lane),
    parseEntries(fs.readFileSync(BASELINE, 'utf8'), lane),
  ) : new Map();
  const seen = new Set();
  const listed = [];
  for (const suite of report.suites) {
    const file = /^[\w.-]+(?:\/[\w.-]+)+$/.test(suite.file) && suite.file.length <= 180
      && !suite.file.split('/').some(segment => segment === '.' || segment === '..')
      ? suite.file : '[path unavailable]';
    for (const test of suite.tests) {
      if (test.status !== 'failed' || seen.has(test.id) || retained.has(test.id)) continue;
      seen.add(test.id);
      if (listed.length < MAX_FAILURES) listed.push(file + ' - ' + displayName(test.fullName));
    }
  }
  // The authoritative gate count also covers reports from a base that predates this reporter.
  if (seen.size !== report.unexpected) throw new Error('Jest failure count did not match the gate');
  return listed;
}

function main() {
  const lane = process.argv[2];
  if (!['unit', 'ui'].includes(lane) || !process.env.GITHUB_STEP_SUMMARY) return;
  const shard = shardOption(process.env.JEST_SHARD);
  const suffix = shard ? '.' + shard.replace('/', '-of-') : '';
  const file = 'ci-reports/jest-results.' + lane + suffix + '.json';
  if (!fs.existsSync(file)) return;
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!report.unexpected || report.lane !== lane || report.shard !== shard || report.proposedDiagnostics
    || report.sha !== process.env.GITHUB_SHA) return;
  const listed = unexpectedFailures(report, lane);
  const omitted = report.unexpected - listed.length;
  const artifactUrl = process.env.JEST_ARTIFACT_URL;
  const body = '### Unexpected Jest assertion failures (' + report.unexpected + ')\n\n<pre>\n'
    + listed.join('\n') + '\n</pre>\n'
    + (omitted ? '\n' + omitted + ' additional unexpected failures omitted.\n' : '')
    + (RUN_ARTIFACT.test(artifactUrl ?? '') ? '\n[Complete Jest result artifact](' + artifactUrl + ')\n' : '');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
}

try { main(); } catch { console.log('Jest assertion summary unavailable'); }
