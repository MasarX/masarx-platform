'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDay, validResult } = require('./nightly-result.cjs');

const excerptBytes = 64 * 1024;

function readBounded(file, maxBytes, tail = false) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !tail && stat.size > maxBytes) throw new Error('Invalid nightly evidence file');
  const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
  const fd = fs.openSync(file, 'r');
  try {
    const count = fs.readSync(fd, buffer, 0, buffer.length, tail ? stat.size - buffer.length : 0);
    return buffer.subarray(0, count).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function safeLabel(label) {
  if (label === label.trim() && /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,119}(?:\.sql)?$/u.test(label)
      && !/\b(?:env(?:ironment)?|hostname|password|token|secret)\b/i.test(label)) return label;
  return null;
}

function excerpt(dir, suites) {
  const markers = new Set(suites.map(suite => '[nightly] ' + suite.status + ' ' + suite.name));
  let log;
  try {
    log = readBounded(path.join(dir, 'nightly.log'), excerptBytes, true);
  } catch {
    return [];
  }
  return [...new Set(log.split(/\r?\n/).filter(line => markers.has(line)))].slice(0, 20);
}

function issueForDay(dir, date, now = new Date()) {
  let result;
  let readError;
  try {
    result = JSON.parse(readBounded(path.join(dir, 'result.json'), 512 * 1024));
    if (!validResult(result) || result.date !== date) throw new Error('Invalid result');
  } catch (error) {
    const today = now.toISOString().slice(0, 10);
    if (error.code === 'ENOENT' && (date > today || date === today && now.getUTCHours() < 6)) return null;
    readError = error.code === 'ENOENT' ? 'The result was missing at 06:00 UTC.' : 'The result could not be validated.';
    result = { sha: null, status: 'error', suites: [] };
  }
  if (result.status === 'green') return null;
  const suites = result.suites.filter(suite => suite.status === 'red' || suite.status === 'error')
    .map(suite => ({ ...suite, name: safeLabel(suite.name), failed_tests: suite.failed_tests.map(safeLabel).filter(Boolean) }))
    .filter(suite => suite.name);
  const lines = suites.slice(0, 25).map(suite => {
    const tests = suite.failed_tests.slice(0, 12);
    return '- ' + suite.name + ' (' + suite.status + ')' + (tests.length ? ' — ' + tests.join(', ') : '');
  });
  const log = excerpt(dir, suites);
  const title = 'Nightly red on main: ' + date + ' ' + (result.sha?.slice(0, 8) || 'unknown');
  return { title, sha: result.sha, labels: ['bug'],
    body: [
      'Kind: Bug',
      'What: The nightly suite result was ' + result.status + '.',
      'Steps: Run the nightly command at the recorded commit.',
      'Expected: All suites pass and the result arrives by 06:00 UTC.',
      'Actual: ' + (readError || 'One or more suites reported a failure.'),
      'Version: ' + (result.sha || 'Unknown'),
      '',
      'Failed suites and tests',
      ...(lines.length ? lines : ['No publishable test names were recorded.']),
      '',
      'Failure log excerpt',
      ...(log.length ? ['```text', ...log, '```'] : ['No publishable failure markers were recorded.']),
    ].join('\n'),
  };
}

function screenIssue(issue, env, run) {
  const head = issue.sha || run('git', ['rev-parse', 'origin/main']).trim();
  const base = run('git', ['merge-base', 'origin/main', head]).trim();
  if (![head, base].every(value => /^[0-9a-f]{40}$/.test(value))) {
    throw new Error('The privacy check requires an exact public main commit');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-issue-'));
  try {
    const body = path.join(dir, 'body.md');
    const id = 'nightly-red-' + Date.now();
    fs.writeFileSync(body, issue.body, { mode: 0o600 });
    const spec = [id, base, head, 'main', issue.title, body].join('|');
    const receipt = run(env.NIGHTLY_DENY_BASH || 'bash', [env.NIGHTLY_DENY_CHECK, spec]);
    if (!receipt.split(/\r?\n/).some(line => line.includes(' END PR-' + id + ' ')
        && /\btry[0-9]+ rc=0 hits=0 .* COMPLETE$/.test(line))) {
      throw new Error('Nightly issue privacy receipt is missing');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function publish(issue, { repo, screen, run }) {
  const existing = JSON.parse(run('gh', ['issue', 'list', '--repo', repo, '--state', 'all', '--search',
    JSON.stringify(issue.title) + ' in:title', '--json', 'title,url']));
  const match = existing.find(item => item.title === issue.title);
  if (match) return match.url;
  const { title, body, labels } = issue;
  const input = JSON.stringify({ title, body, labels });
  screen(issue);
  return run('gh', ['api', '--method', 'POST', 'repos/' + repo + '/issues', '--input', '-', '--jq', '.html_url'], input).trim();
}

function cli(args, env = process.env, now = new Date()) {
  const [folder, flag, ...extra] = args;
  if (!folder || extra.length || flag && flag !== '--dry-run') {
    throw new Error('Usage: node scripts/ci/nightly-report.cjs <results-dir> [--dry-run]');
  }
  const dir = path.resolve(folder);
  const date = path.basename(dir);
  const today = now.toISOString().slice(0, 10);
  const entries = !isDay(date) && fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  const days = isDay(date) ? [[dir, date]]
    : [...new Set([...entries.filter(entry => entry.isDirectory() && isDay(entry.name) && entry.name <= today)
      .map(entry => entry.name), today])].sort().map(day => [path.join(dir, day), day]);
  const issues = days.map(([daily, day]) => issueForDay(daily, day, now)).filter(Boolean);
  if (flag === '--dry-run') return issues;
  if (!issues.length) return [];
  if (!env.GH_TOKEN || !env.NIGHTLY_DENY_CHECK || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) {
    throw new Error('Run the reporter through the issue-scoped App with the repository and privacy checker configured');
  }
  const run = (command, commandArgs, input) => {
    const childEnv = { ...env };
    if (command !== 'gh') {
      delete childEnv.GH_TOKEN;
      delete childEnv.GITHUB_TOKEN;
    }
    const result = spawnSync(command, commandArgs, { env: childEnv, input, encoding: 'utf8',
      timeout: command === 'gh' ? 120000 : undefined, windowsHide: true });
    if (result.status !== 0) throw new Error('Nightly issue screening or App publication failed');
    return result.stdout;
  };
  return issues.map(issue => publish(issue, { repo: env.GITHUB_REPOSITORY,
    screen: candidate => screenIssue(candidate, env, run), run }));
}

if (require.main === module) {
  try {
    const result = cli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { cli, issueForDay, publish, screenIssue };
