'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { targetBase, targetFile } = require('./target-policy.cjs');

const identity = (file, name) => createHash('sha256').update(JSON.stringify([file, name])).digest('hex');
function evaluate(report, expected, exitCode, root) {
  const failed = new Set();
  const seen = new Set();
  let cases = 0;
  let skipped = 0;
  let runtimeError = Boolean(report.numRuntimeErrorTestSuites) || ![0, 1].includes(exitCode);
  for (const suite of report.testResults || []) {
    if (suite.status === 'failed' && !suite.assertionResults?.some(test => test.status === 'failed')) runtimeError = true;
    for (const test of suite.assertionResults || []) {
      const file = path.relative(root, suite.name).split(path.sep).join('/');
      const id = identity(file, test.fullName);
      if (seen.has(id)) runtimeError = true; // Duplicate identities cannot be baselined safely.
      seen.add(id);
      if (['passed', 'failed'].includes(test.status)) cases++;
      else skipped++;
      if (test.status === 'failed') failed.add(id);
    }
  }
  const unexpected = [...failed].filter(id => !expected.has(id));
  const stale = [...expected].filter(id => !failed.has(id));
  const unexplainedExit = exitCode === 1 && !failed.size;
  const snapshotError = Boolean(report.snapshot?.failure || report.snapshot?.unchecked);
  return { failed, unexpected, stale, cases, skipped,
    ok: cases > 0 && !runtimeError && !unexplainedExit && !snapshotError && !unexpected.length && !stale.length };
}
function parseList(text, lane) {
  const found = new Set();
  const all = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    if (!/^(unit|ui|integration)\t[a-f0-9]{64}$/.test(line) || all.has(line)) throw new Error('Malformed/duplicate known-failures entry');
    all.add(line);
    const [kind, id] = line.split('\t');
    if (kind === lane) found.add(id);
  }
  return found;
}
function main() {
  const lane = process.argv[2];
  if (!['unit', 'ui', 'integration'].includes(lane)) throw new Error('Expected unit, ui or integration');
  const root = process.cwd();
  const config = `config/tooling/jest.config${lane === 'integration' ? '' : `.${lane}`}.js`;
  if (!fs.existsSync(config)) throw new Error(`Missing ${config}`);
  // The PR target chooses its baseline; a merge group uses its target branch as well.
  const rawBranch = process.env.CI_BASE_BRANCH || process.env.GITHUB_REF_NAME || '';
  const branch = rawBranch.replace(/^refs\/heads\//, '');
  const list = ['main', 'v2'].includes(branch) ? `config/ci/known-failures.${branch}.txt` : null;
  const base = targetBase();
  const expected = list ? parseList(targetFile(list, base), lane) : new Set();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-jest-'));
  const output = path.join(temp, 'results.json');
  try {
    const script = `test:${lane}`;
    const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts || {};
    if (!scripts[script]) throw new Error(`Missing package.json script ${script}`);
    if (lane === 'unit' && scripts['pretest:unit']) {
      const setup = spawnSync('npm', ['run', 'pretest:unit'], { env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (setup.error || setup.status !== 0) throw new Error('Explicit unit preparation failed');
    }
    const result = spawnSync('npm', ['run', script, '--', '--json', `--outputFile=${output}`, '--reporters=default'], {
      env: { ...process.env, ENV_FILE: os.devNull, ENV_FILE_APPEND: '0', ENV_FILE_OVERRIDE: '0',
        QA_RUN_ID: '', JEST_RETRY_TIMES: '0',
        ...(lane === 'ui' ? {} : { NODE_OPTIONS: '--experimental-vm-modules' }) },
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || !fs.existsSync(output)) throw new Error('Jest infrastructure/configuration failure; no valid JSON result');
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    const verdict = evaluate(report, expected, result.status, root);
    for (const id of verdict.failed) {
      if (expected.has(id)) console.log(`::warning title=Known failure tolerated::${lane}: ${id} from target ${base}`);
    }
    fs.mkdirSync('ci-reports', { recursive: true });
    // Always generated from observed assertions, never a hand-authored exemption list.
    const candidate = [`# observed ${lane}; candidate ${process.env.GITHUB_SHA || 'unknown'}; NOT automatically approved`,
      ...[...verdict.failed].sort().map(id => `${lane}\t${id}`), ''].join('\n');
    fs.writeFileSync(`ci-reports/known-failures-observed.${lane}.txt`, candidate);
    const summary = { lane, baseline: list, baselineSource: base, expected: expected.size, observedFailures: verdict.failed.size,
      executed: verdict.cases, skipped: verdict.skipped,
      unexpected: verdict.unexpected.length, staleOrNotFailed: verdict.stale.length, ok: verdict.ok };
    fs.writeFileSync(`ci-reports/${lane}.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
    if (!verdict.ok) throw new Error('Jest gate failed: new/stale failures, empty suite, snapshots or infrastructure');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { identity, evaluate, parseList };
