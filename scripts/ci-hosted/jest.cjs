'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { targetBase, targetFile } = require('./target-policy.cjs');
const { sanitize, failureDetails } = require('./diagnostics.cjs');

const identity = (file, name) => createHash('sha256').update(JSON.stringify([file, name])).digest('hex');
function evaluate(report, expected, exitCode, root) {
  const failed = new Set();
  const seen = new Set();
  const duplicates = new Set();
  let cases = 0;
  let skipped = 0;
  let runtimeError = Boolean(report.numRuntimeErrorTestSuites) || ![0, 1].includes(exitCode);
  for (const suite of report.testResults || []) {
    if (suite.status === 'failed' && !suite.assertionResults?.some(test => test.status === 'failed')) runtimeError = true;
    for (const test of suite.assertionResults || []) {
      const file = path.relative(root, suite.name).split(path.sep).join('/');
      const id = identity(file, test.fullName);
      if (seen.has(id)) { runtimeError = true; duplicates.add(id); } // Duplicate identities cannot be baselined safely.
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
  const reasons = [
    ...(cases ? [] : ['NO_EXECUTED_ASSERTIONS']),
    ...(runtimeError ? ['RUNTIME_OR_SUITE_LOAD_ERROR'] : []),
    ...(duplicates.size ? ['DUPLICATE_TEST_IDENTITIES'] : []),
    ...(unexplainedExit ? ['EXIT_WITHOUT_FAILED_ASSERTIONS'] : []),
    ...(snapshotError ? ['SNAPSHOT_FAILURE_OR_UNCHECKED'] : []),
    ...(unexpected.length ? ['UNEXPECTED_ASSERTION_FAILURES'] : []),
    ...(stale.length ? ['STALE_EXPECTED_FAILURES'] : []),
  ];
  return { failed, unexpected, stale, cases, skipped, runtimeError, unexplainedExit, snapshotError, duplicates, reasons,
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
function relativeFile(file, root) {
  const relative = path.relative(root, file || root).split(path.sep).join('/');
  return sanitize(relative.startsWith('../') || path.isAbsolute(relative) ? `[external]/${path.basename(file)}` : relative);
}
function resultDetails(report, verdict, result, root) {
  const snapshot = report?.snapshot || {};
  const suites = Array.isArray(report?.testResults) ? report.testResults : [];
  return {
    process: failureDetails(result || {}),
    counts: Object.fromEntries(['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numRuntimeErrorTestSuites',
      'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'].map(key => [key, report?.[key] ?? null])),
    success: report?.success ?? null, wasInterrupted: report?.wasInterrupted ?? null,
    snapshot: { ...Object.fromEntries(Object.entries(snapshot).filter(([, value]) => ['number', 'boolean'].includes(typeof value))),
      filesRemovedList: (snapshot.filesRemovedList || []).map(file => relativeFile(file, root)),
      uncheckedKeysByFile: (snapshot.uncheckedKeysByFile || []).map(row => ({ file: relativeFile(row.filePath, root), keys: (row.keys || []).map(key => sanitize(key)) })) },
    duplicateIdentities: [...(verdict?.duplicates || [])],
    suites: suites.map(suite => ({
      file: relativeFile(suite.name, root), status: suite.status,
      failureMessage: sanitize(suite.message || suite.failureMessage || ''),
      suiteLoadError: suite.testExecError ? sanitize(suite.testExecError.stack || suite.testExecError.message || String(suite.testExecError))
        : suite.status === 'failed' && !suite.assertionResults?.some(test => test.status === 'failed') ? sanitize(suite.message || suite.failureMessage || 'Suite failed without failed assertions') : null,
      tests: (suite.assertionResults || []).map(test => ({
        id: identity(path.relative(root, suite.name).split(path.sep).join('/'), test.fullName),
        fullName: sanitize(test.fullName), status: test.status,
        failureMessages: (test.failureMessages || []).map(message => sanitize(message)),
      })),
    })),
  };
}
function main() {
  const lane = process.argv[2];
  if (!['unit', 'ui', 'integration'].includes(lane)) throw new Error('Expected unit, ui or integration');
  const root = process.cwd();
  const shard = shardOption(process.env.JEST_SHARD);
  const proposedDiagnostics = process.env.JEST_DIAGNOSTIC_PROPOSAL === '1';
  const suffix = (shard ? `.${shard.replace('/', '-of-')}` : '') + (proposedDiagnostics ? '.proposed' : '');
  const list = 'config/ci/known-failures.txt';
  let temp; let base; let authority = new Map(); let entries = new Map(); let expected = new Set();
  let report; let verdict; let result; let stage = 'configuration'; let errorMessage = null;
  try {
    const config = `config/tooling/jest.config${lane === 'integration' ? '' : `.${lane}`}.js`;
    if (!fs.existsSync(config)) throw new Error(`Missing ${config}`);
    // One target-owned baseline for all long-lived branches.
    base = targetBase();
    authority = parseEntries(targetFile(list, base), lane);
    const proposed = fs.existsSync(list) ? parseEntries(fs.readFileSync(list, 'utf8'), lane) : new Map();
    entries = retainedEntries(authority, proposed);
    expected = new Set(entries.keys());
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-jest-'));
    const output = path.join(temp, 'results.json');
    const script = `test:${lane}`;
    const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts || {};
    if (!scripts[script]) throw new Error(`Missing package.json script ${script}`);
    if (lane === 'unit' && scripts['pretest:unit']) {
      stage = 'preparation';
      result = spawnSync('npm', ['run', 'pretest:unit'], { env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.error || result.status !== 0) throw new Error('Explicit unit preparation failed');
    }
    if (shard) {
      stage = 'inventory';
      const collect = args => {
        result = spawnSync('npm', ['run', '--silent', script, '--', '--listTests', '--json', ...args], {
          env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
        });
        if (result.error || result.status !== 0) throw new Error('Jest inventory failed');
        const files = JSON.parse(result.stdout);
        if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error('Invalid Jest inventory');
        return files.map(file => path.relative(root, file).split(path.sep).join('/'));
      };
      expected = expectedForFiles(entries, collect([]), collect([`--shard=${shard}`]));
    }
    stage = 'execution';
    result = spawnSync('npm', ['run', script, '--', ...(shard ? [`--shard=${shard}`] : []), '--json', `--outputFile=${output}`, '--reporters=default'], {
      env: { ...process.env, ENV_FILE: os.devNull, ENV_FILE_APPEND: '0', ENV_FILE_OVERRIDE: '0',
        QA_RUN_ID: '', JEST_RETRY_TIMES: '0',
        ...(lane === 'ui' ? {} : { NODE_OPTIONS: '--experimental-vm-modules' }) },
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (!fs.existsSync(output)) throw new Error('Jest infrastructure/configuration failure; no valid JSON result');
    stage = 'result-parse';
    report = JSON.parse(fs.readFileSync(output, 'utf8'));
    stage = 'gate';
    verdict = evaluate(report, expected, result.error ? null : result.status, root);
    for (const id of verdict.failed) {
      if (expected.has(id)) console.log(`::warning title=Known failure tolerated::${lane}: ${id} from target ${base}`);
    }
    fs.mkdirSync('ci-reports', { recursive: true });
    // Observations never grant an allowance.
    const candidate = [`# observed ${lane}; candidate ${process.env.GITHUB_SHA || 'unknown'}; NOT automatically approved`,
      ...[...verdict.failed].sort().map(id => {
        const suite = report.testResults.find(s => s.assertionResults?.some(t => t.status === 'failed' && identity(path.relative(root, s.name).split(path.sep).join('/'), t.fullName) === id));
        return `${lane}\t${relativeFile(suite.name, root)}\t${id}`;
      }), ''].join('\n');
    fs.writeFileSync(`ci-reports/known-failures-observed.${lane}${suffix}.txt`, candidate);
    if (!verdict.ok) throw new Error(`Jest gate failed: ${verdict.reasons.join(', ')}`);
  } catch (error) {
    errorMessage = sanitize(error.message);
    throw error;
  } finally {
    const summary = { lane, shard, proposedDiagnostics, sha: process.env.GITHUB_SHA || 'unknown', stage, error: errorMessage,
      removedAllowances: authority.size - entries.size, baseline: list, baselineSource: base || null, expected: expected.size,
      observedFailures: verdict?.failed.size ?? 0, executed: verdict?.cases ?? 0, skipped: verdict?.skipped ?? 0,
      unexpected: verdict?.unexpected.length ?? 0, staleOrNotFailed: verdict?.stale.length ?? 0,
      reasons: verdict?.reasons || ['JEST_INFRASTRUCTURE_OR_CONFIGURATION_FAILURE'], ok: verdict?.ok === true };
    fs.mkdirSync('ci-reports', { recursive: true });
    fs.writeFileSync(`ci-reports/${lane}${suffix}.json`, `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(`ci-reports/jest-results.${lane}${suffix}.json`, `${JSON.stringify({ ...summary, ...resultDetails(report, verdict, result, root) }, null, 2)}\n`);
    console.log(JSON.stringify(summary));
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(sanitize(error.message)); process.exitCode = 1; }
}
module.exports = { identity, evaluate, parseList, parseEntries, retainedEntries, shardOption, expectedForFiles, relativeFile, resultDetails };
