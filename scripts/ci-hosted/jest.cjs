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
function parseEntries(text, lane) {
  const found = new Map(); const all = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    const [kind] = fields; const id = fields.at(-1);
    const file = fields.length === 3 ? fields[1] : null;
    if (![2, 3].includes(fields.length) || !['unit', 'ui', 'integration'].includes(kind)
      || !/^[a-f0-9]{64}$/.test(id) || all.has(`${kind}\t${id}`)
      || (file !== null && (!file.startsWith(`tests/${kind}/`) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..')))) {
      throw new Error('Malformed/duplicate known-failures entry');
    }
    all.add(`${kind}\t${id}`);
    if (kind === lane) found.set(id, file);
  }
  return found;
}
function parseList(text, lane) { return new Set(parseEntries(text, lane).keys()); }
function retainedEntries(authority, proposed) {
  return new Map([...authority].filter(([id, file]) => proposed.has(id) && proposed.get(id) === file));
}
function shardOption(value = '') {
  if (!value) return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > 64) throw new Error('Invalid Jest shard');
  return value;
}
function expectedForFiles(entries, inventory, selected) {
  const all = new Set(inventory); const own = new Set(selected);
  if (!all.size || !own.size || all.size !== inventory.length || own.size !== selected.length
    || selected.some(file => !all.has(file))) throw new Error('Invalid Jest shard inventory');
  const expected = new Set();
  for (const [id, file] of entries) {
    if (!file || !all.has(file)) throw new Error('Known failure has no collected file; regenerate the baseline from a real run');
    if (own.has(file)) expected.add(id);
  }
  return expected;
}
function main() {
  const lane = process.argv[2];
  if (!['unit', 'ui', 'integration'].includes(lane)) throw new Error('Expected unit, ui or integration');
  const root = process.cwd();
  const config = `config/tooling/jest.config${lane === 'integration' ? '' : `.${lane}`}.js`;
  if (!fs.existsSync(config)) throw new Error(`Missing ${config}`);
  // One target-owned baseline for all long-lived branches.
  const list = 'config/ci/known-failures.txt';
  const base = targetBase();
  const authority = list ? parseEntries(targetFile(list, base), lane) : new Map();
  const proposed = fs.existsSync(list) ? parseEntries(fs.readFileSync(list, 'utf8'), lane) : new Map();
  const entries = retainedEntries(authority, proposed);
  let expected = new Set(entries.keys());
  const shard = shardOption(process.env.JEST_SHARD);
  const suffix = shard ? `.${shard.replace('/', '-of-')}` : '';
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
    if (shard) {
      const collect = args => {
        const listed = spawnSync('npm', ['run', '--silent', script, '--', '--listTests', '--json', ...args], {
          env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
        });
        if (listed.error || listed.status !== 0) throw new Error('Jest inventory failed');
        const files = JSON.parse(listed.stdout);
        if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error('Invalid Jest inventory');
        return files.map(file => path.relative(root, file).split(path.sep).join('/'));
      };
      expected = expectedForFiles(entries, collect([]), collect([`--shard=${shard}`]));
    }
    const result = spawnSync('npm', ['run', script, '--', ...(shard ? [`--shard=${shard}`] : []), '--json', `--outputFile=${output}`, '--reporters=default'], {
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
      ...[...verdict.failed].sort().map(id => {
        const suite = report.testResults.find(s => s.assertionResults?.some(t => t.status === 'failed' && identity(path.relative(root, s.name).split(path.sep).join('/'), t.fullName) === id));
        return `${lane}\t${path.relative(root, suite.name).split(path.sep).join('/')}\t${id}`;
      }), ''].join('\n');
    fs.writeFileSync(`ci-reports/known-failures-observed.${lane}${suffix}.txt`, candidate);
    const summary = { lane, shard, removedAllowances: authority.size - entries.size, baseline: list, baselineSource: base, expected: expected.size, observedFailures: verdict.failed.size,
      executed: verdict.cases, skipped: verdict.skipped,
      unexpected: verdict.unexpected.length, staleOrNotFailed: verdict.stale.length, ok: verdict.ok };
    fs.writeFileSync(`ci-reports/${lane}${suffix}.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
    if (!verdict.ok) throw new Error('Jest gate failed: new/stale failures, empty suite, snapshots or infrastructure');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { identity, evaluate, parseList, parseEntries, retainedEntries, shardOption, expectedForFiles };
