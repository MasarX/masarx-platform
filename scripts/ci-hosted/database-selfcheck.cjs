'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { isBuiltin } = require('node:module');
const { retry, run, stage, lines, writeReport } = require('./process.cjs');
const { migrationProgress, completePins } = require('./backend.cjs');
const { shardFiles, validateSnapshot } = require('./pgtap.cjs');
const { checkInstallPolicy } = require('./install-policy.cjs');
const { imageRequest, rewrite } = require('./docker-images.cjs');
const { collectStackDiagnostics, belongsToStack, imagePrefix } = require('./stack-diagnostics.cjs');
const { checkTransport } = require('./docker-selfcheck.cjs');
const { migrationIssues, invocation, lintResult } = require('./db-lint.cjs');
const { loadBackendLocalPreSuiteCommands } = require('../ops/ci/cloud-pool-db-local.js');

function checkDatabaseInputs() {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const pending = ['scripts/ci-hosted/backend.cjs', 'scripts/ci-hosted/pgtap.cjs',
    'scripts/ci-hosted/docker-images.cjs', 'scripts/tests/bootstrap/seed-pgtap-fixtures.js'];
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
    'config/ci/hosted-supabase-images.json', 'config/lint/db-lint-exceptions.json', 'supabase/config.toml']) assert.equal(fs.existsSync(file), true, file);
  console.log(`PASS: configured database commands and ${seen.size} transitive module inputs exist`);
}

async function main() {
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
  const names = Array.from({ length: 498 }, (_, i) => `${String(i).padStart(3, '0')}_synthetic.sql`);
  const shards = Array.from({ length: 6 }, (_, i) => shardFiles([...names].reverse(), `${i + 1}/6`));
  assert.deepEqual(shards.map(files => files.length), [83, 83, 83, 83, 83, 83]);
  assert.deepEqual(shards.flat().sort(), names);
  assert.equal(new Set(shards.flat()).size, names.length);
  for (const invalid of ['0/6', '7/6', '1/0', '1/65', '1/6 extra']) assert.throws(() => shardFiles(names, invalid));
  assert.throws(() => shardFiles(['../escape.sql'], '1/1'));
  assert.throws(() => shardFiles(['one.sql', 'one.sql'], '1/1'));
  assert.throws(() => shardFiles(['one.sql'], '2/6'));
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
    const snapshot = { sha: 'a'.repeat(40), image: `public.ecr.aws/${pin.image}@${pin.digest}`, files: {} };
    for (const file of ['database.dump', 'roles.sql']) {
      fs.writeFileSync(path.join(temp, file), 'synthetic');
      snapshot.files[file] = crypto.createHash('sha256').update('synthetic').digest('hex');
    }
    assert.equal(validateSnapshot(snapshot, pins, snapshot.sha, temp), snapshot.image);
    assert.throws(() => validateSnapshot(snapshot, pins, 'b'.repeat(40), temp), /candidate/);
    assert.throws(() => validateSnapshot({ ...snapshot, image: 'unreviewed:tag' }, pins, snapshot.sha, temp), /image/);
    fs.writeFileSync(path.join(temp, 'roles.sql'), 'changed');
    assert.throws(() => validateSnapshot(snapshot, pins, snapshot.sha, temp), /checksum/);
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
  console.log('PASS: bounded retries, complete redacted errors, migration watchdog, snapshot binding and complete deterministic shards');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
