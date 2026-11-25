'use strict';
const fs = require('node:fs');
const { sanitize } = require('./diagnostics.cjs');
const { shardOption } = require('./jest.cjs');

const MAX_FAILURES = 10;
const MAX_FIELD_LENGTH = 180;
const RUN_ARTIFACT = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/artifacts\/\d+$/;

function display(value) {
  const text = sanitize(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, '[URL redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email redacted]')
    .replace(/(^|\s)(?:[a-z]:[\\/]|\/)\S+/gi, '$1[path redacted]')
    .replace(/\s+/g, ' ').trim();
  const bounded = Array.from(text).slice(0, MAX_FIELD_LENGTH).join('') || '[name unavailable]';
  return bounded.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function summary(report, artifactUrl) {
  if (!report.unexpectedAssertionIds?.length) return '';
  const unexpected = new Set(report.unexpectedAssertionIds);
  const listed = [];
  const total = unexpected.size;
  suites: for (const suite of report.suites) {
    const file = /^[\w.-]+(?:\/[\w.-]+)+$/.test(suite.file)
      && !suite.file.split('/').some(segment => segment === '.' || segment === '..')
      ? display(suite.file) : '[path unavailable]';
    for (const test of suite.tests) {
      if (test.status !== 'failed' || !unexpected.delete(test.id)) continue;
      listed.push(file + ' ? ' + display(test.fullName));
      if (listed.length === MAX_FAILURES) break suites;
    }
  }
  const omitted = total - listed.length;
  return '### Unexpected Jest assertion failures (' + total + ')\n\n<pre>\n' + listed.join('\n') + '\n</pre>\n'
    + (omitted ? '\n' + omitted + ' additional unexpected failures omitted.\n' : '')
    + (RUN_ARTIFACT.test(artifactUrl ?? '') ? '\n[Complete Jest result artifact](' + artifactUrl + ')\n' : '');
}

function main() {
  const lane = process.argv[2];
  if (!['unit', 'ui'].includes(lane) || !process.env.GITHUB_STEP_SUMMARY) return;
  const shard = shardOption(process.env.JEST_SHARD);
  const suffix = shard ? '.' + shard.replace('/', '-of-') : '';
  const file = 'ci-reports/jest-results.' + lane + suffix + '.json';
  if (!fs.existsSync(file)) return;
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const body = summary(report, process.env.JEST_ARTIFACT_URL);
  if (body) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
}

try { main(); } catch { console.log('Jest assertion summary unavailable'); }
