'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parse } = require('yaml');
const { browserSuites } = require('./tasks.cjs');
const { shardFiles } = require('./pgtap.cjs');

const policyPath = 'config/ci/test-suite-quarantine.json';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tracked = () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  .split('\0').filter(Boolean);
const testFile = /(?:\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|\.test\.sh$|(?:^|\/)test_[^/]+\.py$|_test\.(?:dart|go|py)$|(?:^|\/)(?:jest|vitest|playwright)[^/]*\.config(?:\.[^.\/]+)*\.[cm]?[jt]s$|(?:^|\/)\.detoxrc\.[cm]?js$|^supabase\/(?:rollback\/)?tests\/.*\.sql$|^tests\/load\/[^/]+\.[cm]?js$)/i;
const owners = new Set(['MasarX Delivery', 'MasarX QA', 'MasarX Design']);

function inventory(files) {
  const discovered = files.filter(file => testFile.test(file));
  for (const manifest of files.filter(file => /(?:^|\/)package\.json$/.test(file))) {
    for (const name of Object.keys(readJson(manifest).scripts || {})) {
      if (/^test(?::|$)/.test(name) && !name.startsWith('test:bootstrap:')) discovered.push(manifest + '#' + name);
    }
  }
  return [...new Set(discovered)].sort();
}

function coverageErrors(discovered, covered, quarantine, today) {
  const discoveredSet = new Set(discovered);
  const unused = new Map();
  const errors = [];
  for (const row of quarantine) {
    const { owner, reason, expires, match } = row;
    if (!Array.isArray(match) || !match.length || match.some(glob => typeof glob !== 'string' || !glob.trim())
      || !owners.has(owner) || typeof reason !== 'string' || !reason.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(expires) || !Number.isFinite(Date.parse(expires))
      || new Date(expires).toISOString().slice(0, 10) !== expires) {
      throw new Error('Invalid suite quarantine row: ' + JSON.stringify(row));
    }
    if (expires < today) errors.push('Expired quarantine (' + expires + '): ' + match.join(', '));
    for (const glob of match) {
      if (unused.has(glob)) throw new Error('Duplicate quarantine selector: ' + glob);
      unused.set(glob, true);
    }
  }
  for (const entry of covered) {
    if (!discoveredSet.has(entry)) errors.push('CI coverage entry has no tracked suite: ' + entry);
  }
  for (const entry of discovered) {
    if (covered.has(entry)) continue;
    const matches = [...unused.keys()].filter(glob => path.posix.matchesGlob(entry, glob));
    if (!matches.length) errors.push('No CI job or quarantine: ' + entry);
    if (matches.length > 1) errors.push('Overlapping quarantine selectors: ' + entry);
    for (const glob of matches) unused.set(glob, false);
  }
  for (const [glob, isUnused] of unused) {
    if (isUnused) errors.push('Quarantine selector no longer covers a suite: ' + glob);
  }
  return errors;
}

function selfCheck() {
  const row = { owner: 'MasarX QA', reason: 'Example', expires: '2000-01-02', match: ['tests/example/*.test.js'] };
  const file = 'tests/example/new.test.js';
  assert.deepEqual(coverageErrors([file], new Set(), [], '2000-01-02'), ['No CI job or quarantine: ' + file]);
  assert.deepEqual(coverageErrors([file], new Set(), [row], '2000-01-02'), []);
  assert.deepEqual(coverageErrors([file], new Set(), [row], '2000-01-03'), ['Expired quarantine (2000-01-02): ' + row.match[0]]);
  assert.deepEqual(coverageErrors([file], new Set([file]), [row], '2000-01-02'), ['Quarantine selector no longer covers a suite: ' + row.match[0]]);
}

function workflow(name) {
  return parse(fs.readFileSync('.github/workflows/' + name + '.yml', 'utf8'));
}

function ciStep(workflow, job, command, gate) {
  const steps = workflow.jobs[job]?.steps.filter(step => step.run?.split('\n').some(line => line.trim() === command));
  if (steps?.length !== 1 || (gate && !workflow.jobs[gate]?.needs.includes(job))) {
    throw new Error('Missing CI producer ' + job + ' for ' + command);
  }
  return steps[0];
}

function listJson(command, args, options) {
  return JSON.parse(execFileSync(command, args, {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }));
}

function playwrightFiles(config, env) {
  const cli = require.resolve('@playwright/test/cli');
  const report = listJson(process.execPath, [cli, 'test', '-c', config, '--list', '--reporter=json'], { env });
  return report.suites.map(suite => path.resolve(report.config.rootDir, suite.file));
}

function ciCoverage(files) {
  const ci = workflow('public-ci');
  const deploy = workflow('deploy');
  const covered = new Set();
  function addFiles(paths) {
    if (!paths.length) throw new Error('CI suite has no test files');
    for (const file of paths) covered.add(path.relative(process.cwd(), file).split(path.sep).join('/'));
  }
  const step = (job, command) => ciStep(ci, job, command, 'ci-gate');
  const addScripts = (manifest, scripts) => scripts.forEach(name => covered.add(manifest + '#' + name));

  for (const [job, kind, config, command] of [
    ['unit', 'unit', 'jest.config.unit.js', 'node scripts/ci-hosted/base-guard.cjs jest.cjs unit'],
    ['ui', 'ui', 'jest.config.ui.js', 'node scripts/ci-hosted/base-guard.cjs jest.cjs ui'],
    ['ui', 'ui:fieldops', 'jest.config.ui.fieldops.js', 'npm run test:ui:fieldops -- --runInBand'],
  ]) {
    step(job, command);
    addFiles(listJson('npm', ['run', '--silent', 'test:' + kind, '--', '--listTests', '--json', '--runInBand']));
    covered.add('config/tooling/' + config);
    addScripts('package.json', ['test:' + kind]);
  }

  const workspace = 'apps/console-v2';
  const vitest = step('ui', 'npm run test --workspace @masarx/console-v2');
  const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json', { paths: [path.resolve(workspace)] })), 'vitest.mjs');
  addFiles(listJson(process.execPath, [vitestBin, 'list', '--filesOnly', '--json'], {
    cwd: workspace, env: { ...process.env, ...vitest.env },
  }).map(row => row.file));
  covered.add(workspace + '/vitest.config.ts');
  addScripts(workspace + '/package.json', ['test', 'test:watch', 'test:coverage']);

  for (const [suite, config] of Object.entries(browserSuites)) {
    const browser = step('e2e', 'node scripts/ci-hosted/tasks.cjs ' + suite);
    addFiles(playwrightFiles(config, { ...process.env, ...browser.env }));
    covered.add(config);
  }
  covered.add('playwright.landing.config.ts');
  covered.add(workspace + '/playwright.a11y.config.ts');
  addScripts('package.json', ['test:e2e:landing']);
  covered.add(workspace + '/playwright.e2e.config.ts');
  addScripts(workspace + '/package.json', ['test:a11y', 'test:e2e:console', 'test:e2e:console:seed']);

  const devConfig = 'playwright.dev-report.config.ts';
  ciStep(deploy, 'e2e-report', 'node node_modules/@playwright/test/cli.js test --config ' + devConfig + ' > /dev/null 2>&1');
  addFiles(playwrightFiles(devConfig, {
    ...process.env, CONSOLE_BASE_URL: 'https://console.example.invalid', PORTAL_BASE_URL: 'https://portal.example.invalid',
    E2E_REQUIRE_BASE_URLS: 'true', ENV_FILE: os.devNull, ENV_FILE_APPEND: '0',
  }));
  covered.add(devConfig);

  step('database-pgtap', 'node scripts/ci-hosted/backend.cjs');
  const tapDir = 'supabase/tests/pgtap';
  const shards = ci.jobs['database-pgtap'].strategy.matrix.shard;
  for (const shard of shards) addFiles(shardFiles(fs.readdirSync(tapDir), shard + '/' + shards.length).map(file => path.join(tapDir, file)));
  addScripts('package.json', ['test:pgtap', 'test:pgtap:local', 'test:pgtap:cloud']);

  for (const { run } of ci.jobs['append-only'].steps) {
    for (const line of (run || '').split('\n')) {
      const match = line.trim().match(/^(?:node --test |bash )(.+)$/);
      if (!match) continue;
      for (const file of match[1].split(/\s+/)) {
        if (files.includes(file) && testFile.test(file)) covered.add(file);
      }
    }
  }
  return covered;
}

try {
  selfCheck();
  const files = tracked();
  const discovered = inventory(files);
  const covered = ciCoverage(files);
  const errors = coverageErrors(discovered, covered, readJson(policyPath), new Date().toISOString().slice(0, 10));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(discovered.length + ' test files and entry points accounted for (' + covered.size + ' covered by CI).');
} catch (error) {
  // Runner subprocess output can include internal paths or configuration. Report the command and exit code only.
  console.error(error.cmd ? 'Test collection failed (exit ' + error.status + '): ' + path.basename(error.cmd.split(' ')[0]) : error.message);
  process.exitCode = 1;
}
