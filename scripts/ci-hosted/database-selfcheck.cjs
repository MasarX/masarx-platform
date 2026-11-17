'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { fork } = require('node:child_process');
const { retry, run, stage, lines, writeReport } = require('./process.cjs');
const { migrationProgress, completePins } = require('./backend.cjs');
const { shardFiles, validateSnapshot } = require('./pgtap.cjs');

async function dockerEof(temp) {
  const pinFile = path.join(temp, 'pins.json'); fs.writeFileSync(pinFile, '[]');
  const connections = new Set(); let guard; let client; let input = '';
  const server = net.createServer({ allowHalfOpen: true }, stream => {
    connections.add(stream); stream.on('close', () => connections.delete(stream)); stream.on('error', () => {});
    let upgraded = false;
    stream.on('data', chunk => {
      input += chunk;
      if (!upgraded && input.includes('\r\n\r\n')) {
        upgraded = true;
        stream.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      }
    });
    stream.on('end', () => setTimeout(() => stream.end('COMPLETED_AFTER_STDIN_EOF'), 25));
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    // A TCP stand-in keeps the daemon's half-close semantics testable on systems with named pipes.
    const preload = path.join(temp, 'connect.cjs');
    fs.writeFileSync(preload, `const net=require('node:net');const connect=net.createConnection;net.createConnection=(options,callback)=>connect({host:'127.0.0.1',port:${server.address().port},allowHalfOpen:options.allowHalfOpen},callback);`);
    guard = fork(path.join(__dirname, 'docker-images.cjs'), [pinFile, 'synthetic'], { execArgv: ['--require', preload], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic guard startup timed out')), 3000);
      guard.once('message', message => { clearTimeout(timer); resolve(message.port); }); guard.once('error', reject);
    });
    const output = await new Promise((resolve, reject) => {
      let result = ''; let ended = false;
      const timer = setTimeout(() => reject(new Error('Docker exec EOF response timed out')), 3000);
      client = net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true }, () => {
        client.write('POST /v1.51/exec/synthetic/start HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n{}');
      });
      client.on('data', chunk => {
        result += chunk;
        if (!ended && result.includes('\r\n\r\n')) { ended = true; client.end('SELECT synthetic;'); }
      });
      client.on('end', () => { clearTimeout(timer); resolve(result); });
      client.on('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(input.endsWith('SELECT synthetic;'), true);
    assert.equal(output.endsWith('COMPLETED_AFTER_STDIN_EOF'), true);
  } finally {
    client?.destroy(); guard?.kill('SIGKILL');
    for (const connection of connections) connection.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
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
    await dockerEof(temp);
    const pins = JSON.parse(fs.readFileSync('config/ci/hosted-supabase-images.json', 'utf8'));
    assert.equal(completePins(pins), true);
    const pin = pins.find(row => row.role === 'database');
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
