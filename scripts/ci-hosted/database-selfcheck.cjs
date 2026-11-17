'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { spawnSync } = require('node:child_process');
const { retry, run, stage, lines, writeReport } = require('./process.cjs');
const { migrationProgress, completePins, backendLint, waitForCronPause } = require('./backend.cjs');
const { shardFiles, shardEnvironment, shardResults } = require('./pgtap.cjs');
const { checkInstallPolicy } = require('./install-policy.cjs');
const { loadExceptions, assessFile, exceptionEvidence } = require('./pgtap-exceptions.cjs');
const { prepareImages } = require('./images.cjs');
const { imageRequest, rewrite } = require('./docker-images.cjs');
const { collectStackDiagnostics, belongsToStack, imagePrefix } = require('./stack-diagnostics.cjs');
const { checkTransport } = require('./docker-selfcheck.cjs');
const { migrationIssues, invocation, lintResult } = require('./db-lint.cjs');
const { loadBackendLocalPreSuiteCommands, loadBackendLocalPgtapEnv, writePsqlWrapper } = require('../ops/ci/cloud-pool-db-local.js');
const { databaseResult, PGTAP_SHARD_COUNT } = require('./database-result.cjs');

const shardIndices = Array.from({ length: PGTAP_SHARD_COUNT }, (_, index) => index + 1);
const shardId = index => `${index}/${PGTAP_SHARD_COUNT}`;

function checkDatabaseInputs() {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const pending = ['scripts/ci-hosted/backend.cjs', 'scripts/ci-hosted/pgtap.cjs',
    'scripts/ci-hosted/docker-images.cjs', 'scripts/ci-hosted/database-result.cjs', 'scripts/tests/bootstrap/seed-pgtap-fixtures.js'];
  for (const { script } of loadBackendLocalPreSuiteCommands()) {
    const match = /^node ([a-zA-Z0-9_./-]+)$/.exec(manifest.scripts[script] || '');
    assert.ok(match, `Missing or unsupported database lint script: ${script}`); pending.push(match[1]);
  }
  const seen = new Set();
  while (pending.length) {
    const file = path.resolve(pending.pop());
    if (seen.has(file)) continue;
    seen.add(file); assert.equal(fs.existsSync(file), true, `Missing database input: ${file}`);
    for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (name.startsWith('.')) {
        const base = path.resolve(path.dirname(file), name);
        const resolved = [base, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, 'index.js')].find(value => fs.existsSync(value) && fs.statSync(value).isFile());
        assert.ok(resolved, `Missing database import: ${name} in ${file}`);
        if (!resolved.endsWith('.json')) pending.push(resolved);
      } else if (!isBuiltin(name)) assert.ok(manifest.dependencies?.[name] || manifest.devDependencies?.[name], `Undeclared database dependency: ${name}`);
    }
  }
  for (const file of ['config/ci/cloud-pool-db-local.json', 'config/ci/deploy-cli-contract.json', 'config/ci/deploy-surfaces.json',
    'config/ci/pgtap-accepted-failures.json', 'config/ci/hosted-supabase-images.json', 'config/lint/db-lint-exceptions.json', 'supabase/config.toml']) assert.equal(fs.existsSync(file), true, file);
  console.log(`PASS: configured database commands and ${seen.size} transitive module inputs exist`);
}

function checkExceptions(temp) {
  const settings = { file: 'synthetic.sql', assertions: ['first assertion', 'second assertion'],
    expires: '2026-12-01', reason: 'synthetic reason', owner: 'synthetic owner' };
  const config = path.join(temp, 'pgtap-exceptions.json');
  fs.writeFileSync(config, JSON.stringify([{ ...settings, assertions: ['duplicate', 'duplicate'] }]));
  assert.throws(() => loadExceptions(config), /Malformed pgTAP exception/);
  fs.writeFileSync(config, JSON.stringify([settings]));
  const entries = loadExceptions(config);
  assert.deepEqual(entries.map(row => row.assertion), settings.assertions);
  const [entry, second] = entries;
  const today = '2026-11-17';
  const assess = (text, status = 0, day = today) => assessFile(entry.file, { status, combined: text }, [entry], day);
  const failed = `1..1\n not ok 1 - ${entry.assertion}    +\n # Looks like you failed 1 test of 1`;
  const accepted = assess(failed);
  assert.equal(accepted.ok, true); assert.equal(accepted.accepted.length, 1);
  assert.equal(assess(failed, 0, '2026-12-02').ok, false);
  assert.match(assess(failed, 0, '2026-12-02').errors[0], /Expired/);
  for (const text of [`1..1\nok 1 - ${entry.assertion}`, '1..1\nnot ok 1 - different text', '']) {
    assert.equal(assess(text).ok, false); assert.match(assess(text).errors[0], /stale exception: remove it/);
  }
  for (const result of [assess(failed, 3), assess(`${failed}\nERROR: synthetic abort`), assess(failed.replace('1..1', '1..2')), assess(failed.replace('failed 1 test', 'failed 2 tests'))]) {
    assert.equal(result.ok, false); assert.equal(result.accepted.length, 0);
  }
  const assessBoth = (combined, day = today) => assessFile(entry.file, { status: 0, combined }, entries, day);
  const bothFailed = '1..2\nnot ok 1 - first assertion\nnot ok 2 - second assertion';
  assert.equal(assessBoth(bothFailed).ok, true);
  assert.deepEqual(assessBoth(bothFailed).accepted, entries);
  assert.deepEqual(assessBoth(bothFailed, '2026-12-02').failures.map(row => row.assertion), settings.assertions);
  const multiple = assessBoth('1..3\nnot ok 1 - first assertion\nnot ok 2 - second assertion\nnot ok 3 - unaccepted assertion');
  assert.equal(multiple.ok, false);
  assert.deepEqual(multiple.accepted, entries);
  assert.deepEqual(multiple.failures.map(row => row.assertion), ['unaccepted assertion']);
  for (const tap of [bothFailed.replace('not ok 2', 'ok 2'), failed]) {
    const stale = assessBoth(tap);
    assert.equal(stale.ok, false);
    assert.deepEqual(stale.accepted, [entry]);
    assert.deepEqual(stale.errors, ['stale exception: remove it: synthetic.sql: second assertion']);
  }
  const report = rows => [{ files: [{ file: entry.file, accepted: rows }] }];
  const evidence = exceptionEvidence(entries, report(multiple.accepted), today);
  assert.deepEqual(evidence.accepted.map(row => row.assertion), settings.assertions);
  assert.deepEqual(evidence.errors, []);
  const missing = exceptionEvidence(entries, report([entry]), today).errors;
  assert.equal(missing.length, 1);
  assert.ok(missing[0].endsWith(second.assertion));
  assert.equal(exceptionEvidence(entries, report(entries), '2026-12-02').accepted.length, 0);
  assert.equal(exceptionEvidence(entries, [], today).errors.length, 2);
  assert.equal(exceptionEvidence(entries, [...report(entries), ...report(entries)], today).errors.length, 2);
  console.log('PASS: assertion lists, exact matches, expiry, per-assertion staleness, SQL aborts and incomplete plans');
  return entry;
}
async function checkImages(pins) {
  const calls = []; const delays = [];
  const summary = { stages: [] };
  const [pin] = pins;
  const registryOf = ref => ref.split('/', 1)[0];
  const pullRefs = () => calls.filter(([command]) => command === 'pull').map(args => args.at(-1));
  let failMirror = false;
  const checked = async (_command, args) => {
    calls.push(args);
    const reference = args.at(-1);
    if (args[0] === 'pull' && registryOf(reference) === 'ghcr.io' && failMirror) {
      throw new Error('synthetic registry failure');
    }
    if (args[0] === 'image') return pins.find(p => reference.split('/').slice(1).join('/') === p.image + '@' + p.digest).image_id;
    return '';
  };
  const options = { env: {}, checked, timed: (name, action) => stage(summary, name, action), summary, wait: async ms => delays.push(ms) };
  const pulling = prepareImages(pins.map(p => ({ ...p })), options);
  assert.equal(pullRefs().length, pins.length, 'every pull starts before the first pull completes');
  await pulling;
  assert.deepEqual(pullRefs(), pins.map(p => 'ghcr.io/' + p.image + '@' + p.digest));
  assert.deepEqual(summary.images.map(row => row.served), pins.map(() => 'ghcr.io'));

  calls.length = 0;
  failMirror = true;
  await prepareImages([{ ...pin }], options);
  assert.deepEqual(pullRefs().map(registryOf), ['ghcr.io', 'ghcr.io', 'ghcr.io', 'public.ecr.aws']);
  assert.deepEqual(delays, [5000, 15000]);

  failMirror = false;
  let finishLastPull;
  const lastPull = new Promise(resolve => { finishLastPull = resolve; });
  const lastPin = pins.at(-1);
  let settled = false;
  const failedPulls = prepareImages(pins.map(p => ({ ...p })), {
    ...options, async checked(command, args) {
      if (args[0] === 'pull' && args.at(-1).includes(pin.image)) throw new Error('synthetic exhausted pull');
      if (args[0] === 'pull' && args.at(-1).includes(lastPin.image)) await lastPull;
      return checked(command, args);
    },
  }).catch(error => { settled = true; throw error; });
  const rejected = assert.rejects(failedPulls, /synthetic exhausted pull/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'failed pulls still join their siblings');
  finishLastPull();
  await rejected;
  assert.equal(summary.images.length, pins.length - 1);

  const bound = pins.map(p => ({ ...p, runtimeId: p.image_id }));
  const create = (image, rules = bound) => rewrite('POST', '/containers/create', Buffer.from(JSON.stringify({ Image: image })), rules);
  for (const host of ['ghcr.io', 'public.ecr.aws']) {
    const image = host + '/' + pin.image + '@' + pin.digest;
    assert.equal(JSON.parse(create(image).body).Image, pin.image_id);
  }
  for (const host of ['ghcr.io.evil.example', 'evil.example/ghcr.io']) {
    const image = host + '/' + pin.image + '@' + pin.digest;
    assert.throws(() => create(image), /outside the reviewed digest set/);
    const route = '/images/' + encodeURIComponent(image) + '/json';
    assert.throws(() => rewrite('GET', route, Buffer.alloc(0), bound), /outside the reviewed digest set/);
    assert.equal(imageRequest('GET', route, Buffer.alloc(0), bound).reviewed, false);
  }
  assert.throws(() => create('ghcr.io/' + pin.image + '@sha256:' + '0'.repeat(64)));
  assert.throws(() => create(pin.image_id, [{ ...bound[0], runtimeId: 'sha256:' + '0'.repeat(64) }]));
  console.log('PASS: exact registry hosts, GHCR digest pulls, bounded ECR fallback and verified image IDs');
}

async function main() {
  const waited = [];
  const settings = ['on', 'off'];
  await waitForCronPause({ query: async () => ({ rows: [{ setting: settings.shift(), context: 'sighup' }] }) }, async ms => waited.push(ms));
  assert.deepEqual(waited, [250]);
  await assert.rejects(waitForCronPause({ query: async () => ({ rows: [] }) }), /Missing reloadable/);
  await assert.rejects(waitForCronPause({ query: async () => ({ rows: [{ setting: 'on', context: 'sighup' }] }) }, async () => {}), /did not acknowledge/);
  checkDatabaseInputs();
  await checkTransport();
  const installer = fs.readFileSync('scripts/ci-hosted/tasks.cjs', 'utf8');
  assert.equal(checkInstallPolicy(new Map([['scripts/ci-hosted/tasks.cjs', installer]])).length, 0);
  assert.equal(checkInstallPolicy(new Map([['scripts/ci-hosted/tasks.cjs', installer.replaceAll("'--ignore-scripts', ", '')]])).length > 0, true);
  let attempts = 0; const delays = [];
  assert.equal(await retry('synthetic reset', async () => { if (++attempts < 3) throw new Error('ECONNRESET'); return 'ok'; }, async ms => delays.push(ms)), 'ok');
  assert.equal(attempts, 3); assert.deepEqual(delays, [5000, 15000]);
  attempts = 0;
  await assert.rejects(retry('synthetic registry', async () => { attempts++; throw new Error('429 toomanyrequests'); }, async () => {}), /429 toomanyrequests/);
  assert.equal(attempts, 3);
  const received = []; const reader = lines(line => received.push(line));
  reader.push('first\r\npass'); reader.push('word=synthetic\nlast'); reader.end();
  assert.deepEqual(received, ['first', 'password=synthetic', 'last']);
  const files = ['20260101_first.sql', '20260102_second.sql'];
  const progress = {}; const tracker = migrationProgress(files, progress, 1, () => 1000);
  assert.equal(tracker.line('unrelated notice'), false);
  assert.equal(tracker.line(`Applying migration ${files[0]}...`), false);
  assert.equal(progress.currentMigration, files[0]);
  assert.equal(tracker.line(`Applying migration ${files[1]}...`), true);
  assert.equal(progress.currentMigration, files[1]);
  assert.throws(() => tracker.line(`Applying migration ${files[1]}...`), /Unexpected migration order/);
  const names = fs.readdirSync('supabase/tests/pgtap').filter(file => /\.sql$/i.test(file)).sort();
  const shards = shardIndices.map(index => shardFiles([...names].reverse(), shardId(index)));
  for (const [index, files] of shards.entries()) {
    assert.deepEqual(files, names.filter((_, offset) => offset % PGTAP_SHARD_COUNT === index));
  }
  assert.deepEqual(shards.flat().sort(), names);
  assert.equal(new Set(shards.flat()).size, names.length);
  const mixedCase = ['a.SQL', 'b.sQl', 'c.sql', 'ignored.txt'];
  assert.deepEqual(Array.from({ length: 3 }, (_, index) => shardFiles(mixedCase, `${index + 1}/3`)).flat().sort(), mixedCase.slice(0, 3));
  for (const invalid of [shardId(0), shardId(PGTAP_SHARD_COUNT + 1), '1/0', '1/65', `${shardId(1)} extra`]) assert.throws(() => shardFiles(names, invalid));
  assert.throws(() => shardFiles(['../escape.sql'], '1/1'));
  assert.throws(() => shardFiles(['one.sql', 'one.sql'], '1/1'));
  assert.throws(() => shardFiles(['one.sql'], shardId(2)));
  const contract = loadBackendLocalPgtapEnv();
  const testEnv = shardEnvironment({ DATABASE_URL: 'postgresql://synthetic@127.0.0.1:54322/postgres', PATH: 'synthetic-bin' }, contract, 'synthetic', 54322, ['one.sql']);
  for (const name of ['PGTAP_FILES_PER_SESSION', 'PGTAP_NODE_FILE_RETRIES', 'PGTAP_RETRY_TRANSIENT', 'PGTAP_RETRY_DEADLOCKS', 'PGTAP_FULL_LOCAL_QUALIFICATION']) assert.equal(testEnv[name], contract[name]);
  assert.equal(testEnv.ENV_FILE, os.devNull);
  assert.equal(testEnv.ENV_FILE_OVERRIDE, '0');
  assert.equal(testEnv.PGTAP_ONLY_FILES, 'one.sql');
  assert.equal(testEnv.DB_LOCAL_PROJECT_ID, 'synthetic');
  assert.equal(testEnv.DATABASE_URL, 'postgresql://synthetic@127.0.0.1:54322/postgres');
  assert.deepEqual(shardResults(['one.sql'], []).notRun, ['one.sql']);
  assert.deepEqual(shardResults(['one.sql', 'two.sql'], [{ file: 'one.sql', status: 'failed' }]), {
    files: [{ file: 'one.sql', status: 'failed' }], run: 1, passed: 0, failed: 1, notRun: ['two.sql'],
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'database-selfcheck-'));
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  try {
    const lintEnv = { SUPABASE_CLI_BIN: 'synthetic-cli', DATABASE_URL: 'postgresql://postgres:synthetic-password@127.0.0.1:54322/postgres',
      SYNTHETIC_TOKEN: 'synthetic-hidden', PATH: process.env.PATH };
    const command = invocation(lintEnv);
    assert.equal(command.command, 'synthetic-cli');
    assert.equal(command.args.includes('--fail-on'), true);
    assert.equal(command.args.some(value => value.includes('synthetic-password')), false);
    assert.equal(command.env.PGPASSWORD, 'synthetic-password');
    assert.equal(command.env.SYNTHETIC_TOKEN, undefined);
    assert.throws(() => invocation({ ...lintEnv, SUPABASE_CLI_BIN: '' }), /verified CLI/);
    assert.throws(() => invocation({ ...lintEnv, DATABASE_URL: 'postgresql://postgres@unreviewed.invalid/postgres' }), /loopback/i);
    assert.throws(() => invocation({ ...lintEnv, DATABASE_URL: lintEnv.DATABASE_URL + '?password=other' }), /Ambiguous/);
    const registry = [{ extension: 'synthetic_extension' }];
    const ownership = new Map([['public.synthetic_extension_fn', 'synthetic_extension']]);
    const ignored = { function: 'public.synthetic_extension_fn', issues: [{ level: 'error', message: 'synthetic' }] };
    const failure = { function: 'public.synthetic_product_fn', issues: [{ level: 'error', message: 'synthetic product failure' }] };
    assert.equal(lintResult('', 0, registry, ownership).exitCode, 0);
    assert.equal(lintResult('', 7, registry, ownership).exitCode, 7);
    assert.equal(lintResult(JSON.stringify([ignored]), 1, registry, ownership).exitCode, 0);
    assert.equal(lintResult(JSON.stringify([ignored]), 1, registry, new Map()).exitCode, 1);
    assert.equal(lintResult(JSON.stringify([ignored, failure]), 1, registry, ownership).exitCode, 1);
    assert.equal(lintResult(JSON.stringify([failure]), 0, registry, ownership).exitCode, 1);
    assert.throws(() => lintResult('{}', 0, registry, ownership), /Malformed/);
    assert.throws(() => lintResult('[{"function":"synthetic","issues":[{}]}]', 0, registry, ownership), /Malformed/);
    assert.throws(() => lintResult('[]', null, registry, ownership), /normally/);
    const lintFile = path.join(temp, 'db-lint.json');
    const finding = { function: 'public.synthetic_product_fn', message: 'synthetic product finding' };
    fs.writeFileSync(lintFile, JSON.stringify({ ok: false, findings: [finding], ignored: 1 }));
    const lintReport = { stages: [] }; const lintCommands = [];
    await backendLint(lintReport, [{ script: 'lint:db' }, { script: 'lint:db:fixtures' }], async command => {
      lintCommands.push(command.script);
      if (command.script === 'lint:db') throw new Error('synthetic lint failure');
    }, lintFile);
    assert.deepEqual(lintCommands, ['lint:db', 'lint:db:fixtures']);
    assert.equal(lintReport.lint.ok, false);
    assert.equal(lintReport.stages[0].status, 'failed');
    assert.deepEqual(lintReport.lint.findings, [finding]);
    fs.writeFileSync(lintFile, '{bad');
    await backendLint(lintReport, [{ script: 'lint:db' }], async () => {}, lintFile);
    assert.equal(lintReport.lint.ok, false);
    fs.writeFileSync(lintFile, JSON.stringify({ ok: true, findings: [], ignored: 0 }));
    await backendLint(lintReport, [{ script: 'lint:db' }], async () => {}, lintFile);
    assert.equal(lintReport.lint.ok, true);
    const aggregateEnv = { BUILD_RESULT: 'success', DATABASE_PRESENT: 'true', PGTAP_RESULT: 'success', GITHUB_SHA: 'a'.repeat(40) };
    const built = { sha: aggregateEnv.GITHUB_SHA, ok: true, migrations: 2324, migrationTotal: 2324,
      migrationFailed: 0, migrationNotRun: 0, lint: { ok: true, findings: [], ignored: 0 } };
    const shardReports = shardIndices.map(index => ({ sha: aggregateEnv.GITHUB_SHA, shard: shardId(index),
      migrations: 2324, migrationFailed: 0, migrationNotRun: 0,
      ok: true, run: 1, passed: 1, failed: 0, selected: [`${index - 1}_synthetic.sql`], notRun: [], files: [] }));
    assert.equal(databaseResult(built, shardReports, aggregateEnv).ok, true);
    const lintFailed = databaseResult({ ...built, ok: false, lint: { ok: false, findings: [finding], ignored: 1 } }, shardReports, aggregateEnv);
    assert.equal(lintFailed.ok, false);
    assert.equal(lintFailed.markdown.includes(finding.function) && lintFailed.markdown.includes(finding.message), true);
    assert.equal(lintFailed.markdown.includes(`| ${shardId(PGTAP_SHARD_COUNT)} | 2324 / 0 | 1 | 1 | 0 | PASS |`), true);
    assert.equal(databaseResult(built, [{ ...shardReports[0], ok: false, failed: 1, passed: 0 }, ...shardReports.slice(1)], aggregateEnv).ok, false);
    const failedFile = databaseResult(built, [{ ...shardReports[0], ok: false, failed: 1, passed: 0,
      files: [{ file: '0_synthetic.sql', status: 'failed', error: 'tool exit 3\nERROR: synthetic SQL error\nDETAIL: synthetic detail' }] }, ...shardReports.slice(1)], aggregateEnv);
    assert.equal(failedFile.markdown.includes('0_synthetic.sql: ERROR: synthetic SQL error'), true);
    assert.equal(databaseResult(built, [{ ...shardReports[0], migrations: 2323 }, ...shardReports.slice(1)], aggregateEnv).ok, false);
    assert.equal(databaseResult(built, shardReports.slice(1), aggregateEnv).ok, false);
    assert.equal(databaseResult(built, [shardReports[0], ...shardReports.slice(0, -1)], aggregateEnv).ok, false);
    assert.equal(databaseResult(built, [{ ...shardReports[0], sha: 'b'.repeat(40) }, ...shardReports.slice(1)], aggregateEnv).ok, false);
    assert.equal(databaseResult(undefined, shardReports, aggregateEnv).ok, false);
    assert.equal(databaseResult({ ...built, migrationFailed: 1 }, shardReports, aggregateEnv).ok, false);
    assert.equal(databaseResult(built, shardReports, { ...aggregateEnv, PGTAP_RESULT: 'failure' }).ok, false);
    const absentEnv = { ...aggregateEnv, DATABASE_PRESENT: 'false' };
    assert.equal(databaseResult(undefined, [], absentEnv).ok, true);
    assert.equal(databaseResult(undefined, [], { ...absentEnv, PGTAP_RESULT: 'failure' }).ok, false);
    assert.equal(databaseResult(undefined, [], { ...absentEnv, PGTAP_RESULT: 'skipped' }).ok, false);
    assert.equal(databaseResult(undefined, shardReports, absentEnv).ok, false);
    const aggregateDir = path.join(temp, 'aggregate');
    const fixture = (file, value) => {
      const target = path.join(aggregateDir, 'ci-reports/database-result', file);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(value));
    };
    fs.mkdirSync(path.join(aggregateDir, 'config/ci'), { recursive: true });
    fs.writeFileSync(path.join(aggregateDir, 'config/ci/pgtap-accepted-failures.json'), '[]');
    fixture('build/backend.json', built);
    for (const index of shardIndices) fixture(`shards/pgtap-summary-${index}-123-1/pgtap.json`, shardReports[index - 1]);
    const aggregateSummary = path.join(temp, 'aggregate.md');
    const aggregate = () => spawnSync(process.execPath, [path.resolve('scripts/ci-hosted/database-result.cjs')], {
      cwd: aggregateDir, env: { ...process.env, ...aggregateEnv, GITHUB_STEP_SUMMARY: aggregateSummary }, encoding: 'utf8', timeout: 5000,
    });
    const flat = aggregate();
    assert.equal(flat.status, 0, flat.error?.message || flat.stderr);
    assert.equal(flat.stdout.includes('| 2324 | 0 | 0 |'), true);
    fixture('build/backend.json', { ...built, ok: false, lint: { ok: false, findings: [finding], ignored: 1 } });
    const flatLint = aggregate();
    assert.equal(flatLint.status, 1);
    assert.equal(flatLint.stdout.includes(finding.function) && flatLint.stdout.includes(finding.message), true);
    assert.equal(flatLint.stdout.includes('Invalid report artifact'), false);
    fixture('build/backend-summary-123-1/backend.json', built);
    assert.equal(aggregate().status, 1); // Mixed flat/nested reports are ambiguous.
    fs.renameSync(path.join(aggregateDir, 'ci-reports/database-result/build/backend.json'), path.join(aggregateDir, 'ci-reports/database-result/build/backend.retired'));
    assert.equal(aggregate().status, 0);
    fixture('build/backend-summary-123-2/backend.json', { ...built, ok: false, lint: { ok: false, findings: [finding] } });
    assert.equal(aggregate().status, 1);
    assert.equal(fs.readFileSync(aggregateSummary, 'utf8').includes(finding.message), true);
    fixture('build/backend-summary-123-3/backend.json', built);
    fixture('shards/pgtap-summary-1-123-2/pgtap.json', { ...shardReports[0], ok: false, failed: 1, passed: 0 });
    assert.equal(aggregate().status, 1);
    fixture('shards/pgtap-summary-1-123-3/pgtap.json', shardReports[0]);
    assert.equal(aggregate().status, 0);
    fs.writeFileSync(path.join(aggregateDir, 'ci-reports/database-result/shards/pgtap-summary-1-123-3/pgtap.json'), '{bad');
    assert.equal(aggregate().status, 1);
    const migration = path.join(temp, '20260101000000_synthetic.sql');
    fs.writeFileSync(migration, 'select 1;');
    assert.deepEqual(migrationIssues([migration], {}), []);
    fs.writeFileSync(migration, 'select seed_client;');
    assert.equal(migrationIssues([migration], {}).some(message => message.includes('Client-specific seeding')), true);
    fs.writeFileSync(migration, "select 'test-client-synthetic';");
    assert.equal(migrationIssues([migration], {}).some(message => message.includes('Fixture slug')), true);
    fs.writeFileSync(migration, 'select 1;');
    assert.equal(migrationIssues([migration, migration], {}).some(message => message.includes('duplicate')), true);
    const pins = JSON.parse(fs.readFileSync('config/ci/hosted-supabase-images.json', 'utf8'));
    assert.equal(completePins(pins), true);
    const pin = pins.find(row => row.role === 'database');
    const traced = imageRequest('GET', '/v1.51/images/public.ecr.aws%2Fsupabase%2Fpostgres%3Aother/json', Buffer.alloc(0), pins);
    assert.equal(traced.reviewed, true);
    assert.equal(traced.reference, `public.ecr.aws/${pin.image}@${pin.digest.slice(0, 19)}`);
    const missing = imageRequest('POST', '/v1.51/images/create?fromImage=public.ecr.aws%2Fsupabase%2Funreviewed&tag=latest', Buffer.alloc(0), pins);
    assert.equal(missing.image, 'public.ecr.aws/supabase/unreviewed:latest');
    assert.equal(missing.reviewed, false);
    assert.equal(imageRequest('GET', '/images/%bad/json', Buffer.alloc(0), pins), null);
    assert.equal(imageRequest('POST', '/containers/create', Buffer.from('{bad'), pins), null);
    assert.equal(imageRequest('POST', '/containers/create', Buffer.from('{"Image":"unreviewed/image:v1"}'), pins).reviewed, false);
    assert.throws(() => rewrite('POST', '/images/create?fromImage=anything', Buffer.alloc(0), pins));
    assert.throws(() => rewrite('POST', '/containers/create', Buffer.from('{"Image":"unreviewed/image:v1"}'), pins));
    assert.equal(imagePrefix(`supabase/postgres@sha256:${'a'.repeat(64)}`), `supabase/postgres@sha256:${'a'.repeat(12)}`);
    assert.equal(belongsToStack({ Names: 'anonymous', Labels: 'com.supabase.cli.project=synthetic' }, 'synthetic'), true);
    assert.equal(belongsToStack({ Names: 'supabase_db_synthetic-other' }, 'synthetic'), false);
    const commands = [];
    const rows = [
      { ID: 'db', Names: 'supabase_db_synthetic', Image: `supabase/postgres@${pin.digest}`, Status: 'Up (unhealthy)' },
      { ID: 'job', Names: 'anonymous', Image: 'supabase/realtime:synthetic', Labels: 'com.supabase.cli.project=synthetic', Status: 'Restarting' },
      { ID: 'other', Names: 'unrelated', Image: 'synthetic/other:v1', Status: 'Up' },
    ];
    const details = rows.map(row => ({ id: row.ID, imageId: `sha256:${'b'.repeat(64)}`, state: row.ID === 'db'
      ? { Health: { Status: 'unhealthy', Log: [{ Output: 'password=synthetic-hidden' }] } }
      : row.ID === 'job' ? { Restarting: true, Status: 'restarting' } : { Status: 'running' } }));
    const diagnosticLog = path.join(temp, 'startup.log');
    const requestTrace = [{ sequence: 1, method: 'POST', path: '/v1.48/containers/aaaaaaaaaaaa/wait', status: 200, durationMs: 500, upgraded: false }];
    const diagnostics = await collectStackDiagnostics({ project: 'synthetic', env: process.env, dockerRoot: '/synthetic/docker',
      imagePolicy: { decision: 'denied', denied: 1, imageRequests: [traced, missing], requests: requestTrace }, logFile: diagnosticLog,
      execute: async (command, args, options) => {
        commands.push([command, args]);
        assert.equal(options.quiet, true); assert.equal(options.timeout > 0 && options.timeout <= 10000, true);
        if (command === 'docker' && args[0] === 'logs') assert.equal(options.includeStderr, true);
        if (command === 'free') throw new Error('synthetic memory command failure');
        if (command === 'df') return 'synthetic disk free';
        if (args[0] === 'ps') return rows.map(row => JSON.stringify(row)).join('\n');
        if (args[0] === 'inspect') return details.map(row => JSON.stringify(row)).join('\n');
        return 'service error password=synthetic-hidden';
      } });
    assert.equal(diagnostics.containers.length, 3);
    assert.deepEqual(diagnostics.containerRequests, requestTrace);
    assert.equal(fs.readFileSync(diagnosticLog, 'utf8').includes('Guarded container request (admission order):'), true);
    assert.deepEqual(diagnostics.logs.map(row => row.name), ['supabase_db_synthetic', 'anonymous']);
    assert.equal(diagnostics.unhealthy.length, 2);
    assert.equal(diagnostics.unreviewedImages[0].image, missing.image);
    assert.equal(diagnostics.errors.length, 1);
    assert.equal(JSON.stringify(diagnostics).includes('synthetic-hidden'), false);
    assert.equal(fs.readFileSync(diagnosticLog, 'utf8').includes('synthetic-hidden'), false);
    assert.deepEqual(commands.filter(([, args]) => args[0] === 'logs').map(([, args]) => args.slice(1)), [
      ['--tail', '60', '--timestamps', 'db'], ['--tail', '60', '--timestamps', 'job'],
    ]);
    const combined = await run(process.execPath, ['-e', "console.log('synthetic stdout'); console.error('synthetic stderr')"], { quiet: true, includeStderr: true });
    assert.equal(combined.includes('synthetic stdout') && combined.includes('synthetic stderr'), true);
    const wrapper = fs.readFileSync(writePsqlWrapper(path.join(temp, 'client'), `public.ecr.aws/${pin.image}@${pin.digest}`), 'utf8');
    assert.equal(wrapper.includes(`public.ecr.aws/${pin.image}@${pin.digest}`), true);
    assert.equal(wrapper.includes('-v "$PWD:$PWD"'), true);
    await checkImages(pins);
    const exception = checkExceptions(temp);
    const Module = require('node:module');
    const originalLoad = Module._load;
    let runner;
    try {
      const blocked = class { constructor() { throw new Error('Database connections are forbidden in this selfcheck'); } };
      Module._load = function (name, ...args) { return name === 'pg' ? { Client: blocked, Pool: blocked } : originalLoad.call(this, name, ...args); };
      runner = require('../tests/run-pgtap-cloud.js');
    } finally { Module._load = originalLoad; }
    for (const [status, combined] of [[3, 'NOTICE: synthetic\nERROR: synthetic SQL error'], [0, '1..1\nnot ok 1 - synthetic assertion']]) {
      assert.throws(() => runner.runPsqlWithCandidateFallback([{ name: 'synthetic', dsn: testEnv.DATABASE_URL }], [], 'one.sql', {
        runPsqlCaptureFn: () => ({ status, combined }),
      }), error => error.message.includes(combined.split('\n')[1]));
    }
    const acceptedOutput = `1..1\nnot ok 1 - ${exception.assertion}\n# Looks like you failed 1 test of 1`;
    const options = { runPsqlCaptureFn: () => ({ status: 0, combined: acceptedOutput }),
      assessResult: result => assessFile(exception.file, result, [exception], '2026-11-17') };
    assert.equal(runner.runPsqlWithCandidateFallback([{ name: 'synthetic', dsn: testEnv.DATABASE_URL }], [], exception.file, options).assessment.accepted.length, 1);
    assert.throws(() => runner.runPsqlWithCandidateFallback([{ name: 'synthetic', dsn: testEnv.DATABASE_URL }], [], exception.file,
      { ...options, runPsqlCaptureFn: () => ({ status: 3, combined: `${acceptedOutput}\nERROR: synthetic abort` }) }), /ERROR: synthetic abort/);
    const adversarial = '/images/a'.repeat(100000) + '/json';
    const parseStart = performance.now();
    for (let i = 0; i < 100; i++) {
      assert.equal(imageRequest('GET', adversarial, Buffer.alloc(0), pins), null);
      assert.throws(() => rewrite('GET', adversarial, Buffer.alloc(0), pins), /bound/);
      assert.equal(imageRequest('GET', '/images/a'.repeat(800) + '/json', Buffer.alloc(0), pins), null);
    }
    const parseMs = performance.now() - parseStart;
    assert.ok(parseMs < 1000, `Adversarial path parsing took ${parseMs}ms`);
    console.log(`PASS: 200 long/adversarial Docker paths in ${parseMs.toFixed(1)}ms`);
    const report = { stages: [] };
    await stage(report, 'success', async () => {});
    await assert.rejects(stage(report, 'failure', async () => { throw new Error('synthetic'); }));
    assert.deepEqual(report.stages.map(row => row.status), ['passed', 'failed']);
    assert.equal(report.stages.every(row => row.startedAt && row.endedAt && row.durationMs >= 0), true);
    process.env.GITHUB_STEP_SUMMARY = path.join(temp, 'summary.md');
    writeReport(path.join(temp, 'report.json'), report);
    assert.equal(fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8').includes('| Stage | Start UTC | End UTC | Seconds | Result |'), true);
    const logFile = path.join(temp, 'process.log');
    const credential = 'synthetic secret spanning chunks';
    await assert.rejects(run(process.execPath, ['-e', "process.stdout.write('early tool error: 429 rate limit\\n'); process.stdout.write('line\\n'.repeat(100)); process.stdout.write(process.env.SYNTHETIC_TOKEN.slice(0,10)); setTimeout(()=>{process.stdout.write(process.env.SYNTHETIC_TOKEN.slice(10)+'\\n');process.exit(7)},20)"],
      { env: { ...process.env, SYNTHETIC_TOKEN: credential }, logFile }), error => {
      assert.equal(error.failure.exitCode, 7);
      assert.equal(error.failure.output.includes('early tool error: 429 rate limit'), true);
      assert.equal(error.failure.output.includes(credential), false);
      assert.equal(fs.readFileSync(logFile, 'utf8').includes(credential), false);
      return true;
    });
    const start = Date.now();
    await assert.rejects(run(process.execPath, ['-e', "setInterval(()=>console.log('notice, no completed migration'),10)"],
      { idleMs: 150, idleMessage: () => 'Hung migration: 20260101_first.sql', timeout: 5000 }), /Hung migration: 20260101_first.sql/);
    assert.equal(Date.now() - start < 4500, true);
    await assert.rejects(run(process.execPath, ['-e', "setInterval(()=>{},1000)"], { timeout: 150 }), error => error.failure.timeout);
    await assert.rejects(run(path.join(temp, 'missing-executable'), []), error => error.failure.errorCode === 'ENOENT');
  } finally {
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('PASS: bounded retries, complete redacted errors, migration watchdog and deterministic from-zero pgTAP shards');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
