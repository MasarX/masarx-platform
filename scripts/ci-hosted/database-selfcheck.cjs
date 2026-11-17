'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { retry, run, stage, lines, writeReport } = require('./process.cjs');
const { migrationProgress, completePins } = require('./backend.cjs');
const { shardFiles, validateSnapshot } = require('./pgtap.cjs');
const { checkInstallPolicy } = require('./install-policy.cjs');
const { imageRequest, rewrite } = require('./docker-images.cjs');
const { collectStackDiagnostics, belongsToStack, imagePrefix } = require('./stack-diagnostics.cjs');
const { checkTransport } = require('./docker-selfcheck.cjs');

async function main() {
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
