'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { isDay, validResult } = require('./nightly-result.cjs');
const { origin } = require('../../config/ci/nightly-target.json');

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
  if (label.length <= 120 && label === label.trim() && /^[\p{L}\p{N}][\p{L}\p{N} _-]*(?:\.sql)?$/u.test(label)
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
  const today = now.toISOString().slice(0, 10);
  if (date > today) return null;
  let result;
  let readError;
  let missing = false;
  try {
    result = JSON.parse(readBounded(path.join(dir, 'result.json'), 512 * 1024));
    if (!validResult(result) || result.date !== date) throw new Error('Invalid result');
  } catch (error) {
    missing = error.code === 'ENOENT';
    if (missing && date === today && now.getUTCHours() < 6) return null;
    readError = missing ? 'The result was missing at 06:00 UTC.' : 'The result could not be validated.';
    result = { sha: null, status: 'error', suites: [] };
  }
  if (result.status === 'green') return null;
  const failed = result.suites.filter(suite => suite.status === 'red' || suite.status === 'error');
  const suites = failed
    .map(suite => ({ ...suite, name: safeLabel(suite.name), failed_tests: suite.failed_tests.map(safeLabel).filter(Boolean) }))
    .filter(suite => suite.name);
  const lines = suites.slice(0, 25).map(suite => {
    const tests = suite.failed_tests.slice(0, 12);
    return '- ' + suite.name + ' (' + suite.status + ')' + (tests.length ? ' — ' + tests.join(', ') : '');
  });
  const log = excerpt(dir, suites);
  const state = missing ? 'missing' : result.status;
  const title = 'Nightly ' + state + ' on main: ' + date + ' ' + (result.sha?.slice(0, 8) || 'unknown');
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const signature = '<!-- nightly-suites ' + digest([state, [...new Set(failed.map(suite => suite.name))].sort()]) + ' -->';
  const receipt = '<!-- nightly-report ' + digest(title) + ' -->';
  return { title, date, sha: result.sha, labels: ['bug'], signature, receipt,
    body: [
      'Kind: Bug',
      'What: The nightly suite result was ' + result.status + '.',
      'Steps: Run the nightly command at the recorded commit.',
      'Expected: All suites pass and the result arrives by 06:00 UTC.',
      'Actual: ' + (readError || 'One or more suites reported a failure.'),
      'Version: ' + (result.sha || 'Unknown'),
      'Run evidence: ' + date + ' UTC, result.json and nightly.log in the private nightly archive.',
      '',
      'Failed suites and tests',
      ...(lines.length ? lines : ['No publishable test names were recorded.']),
      '',
      'Failure log excerpt',
      ...(log.length ? ['```text', ...log, '```'] : ['No publishable failure markers were recorded.']),
      '', signature, receipt,
    ].join('\n'),
  };
}

function screenIssue(issue, env, run) {
  const overrides = run('git', ['config', '--name-only', '--get-regexp',
    '^(url\\..*insteadof$|http\\..*(extraheader|cookiefile|sslcert|sslkey)$)']).trim();
  if (overrides) throw new Error('Anonymous main fetch has Git authentication or URL overrides');
  const ref = 'refs/nightly/public-main';
  run('git', ['-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false',
    'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', origin, 'refs/heads/main:' + ref]);
  const main = run('git', ['rev-parse', '--verify', ref]).trim();
  const head = issue.sha || main;
  if (![main, head].every(value => /^[0-9a-f]{40}$/.test(value))) {
    throw new Error('The privacy check requires an exact public main commit');
  }
  run('git', ['merge-base', '--is-ancestor', head, main]);
  const base = run('git', ['merge-base', main, head]).trim();
  if (![head, base].every(value => /^[0-9a-f]{40}$/.test(value))) {
    throw new Error('The privacy check requires an exact public main commit');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-issue-'));
  try {
    const body = path.join(dir, 'body.md');
    const id = 'nightly-report-' + Date.now();
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
  const active = JSON.parse(run('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--label', 'bug',
    '--search', '"Nightly ' + issue.title.split(' ')[1] + ' on main" in:title', '--limit', '100', '--json', 'number,title,body,url']));
  const repeated = active.find(item => item.title.startsWith('Nightly ') && item.body?.split(/\r?\n/).includes(issue.signature));
  if (repeated) {
    const endpoint = 'repos/' + repo + '/issues/' + repeated.number + '/comments';
    const comments = JSON.parse(run('gh', ['api', '--paginate', '--slurp', endpoint + '?per_page=100'])).flat();
    if (!comments.some(comment => comment.body?.split(/\r?\n/).includes(issue.receipt))) {
      const body = issue.title + '\n\n' + issue.body;
      screen({ ...issue, body });
      run('gh', ['api', '--method', 'POST', endpoint, '--input', '-', '--jq', '.html_url'], JSON.stringify({ body }));
    }
    return repeated.url;
  }
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
  const prior = entries.filter(entry => entry.isDirectory() && isDay(entry.name) && entry.name <= today)
    .map(entry => entry.name).sort();
  const days = [];
  if (isDay(date)) days.push([dir, date]);
  else {
    for (const day = new Date(prior[0] || today); day.toISOString().slice(0, 10) <= today; day.setUTCDate(day.getUTCDate() + 1)) {
      const label = day.toISOString().slice(0, 10);
      days.push([path.join(dir, label), label]);
    }
  }
  const issues = days.map(([daily, day]) => issueForDay(daily, day, now)).filter(Boolean);
  if (flag === '--dry-run') return issues;
  if (!issues.length) return [];
  if (!env.GH_TOKEN || !env.NIGHTLY_DENY_CHECK || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) {
    throw new Error('Run the reporter through the issue-scoped App with the repository and privacy checker configured');
  }
  const run = (command, commandArgs, input) => {
    const childEnv = command === 'git' ? Object.fromEntries(Object.entries(env).filter(([key]) =>
      /^(?:path|systemroot|windir|comspec|temp|tmp|tmpdir)$/i.test(key))) : { ...env };
    if (command === 'git') Object.assign(childEnv, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_NO_REPLACE_OBJECTS: '1' });
    if (command !== 'gh') {
      delete childEnv.GH_TOKEN;
      delete childEnv.GITHUB_TOKEN;
    }
    const result = spawnSync(command, commandArgs, { env: childEnv, input, encoding: 'utf8',
      timeout: command === 'gh' ? 120000 : command === 'git' ? 60000 : undefined, windowsHide: true });
    if (command === 'git' && commandArgs[0] === 'config' && result.status === 1) return '';
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

module.exports = { cli, issueForDay, publish, safeLabel, screenIssue };
