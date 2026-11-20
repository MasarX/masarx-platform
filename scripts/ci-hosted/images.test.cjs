'use strict';
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { mock, test } = require('node:test');
const { setImmediate: flush } = require('node:timers/promises');

let fixture;
mock.method(childProcess, 'spawn', (...args) => fixture.spawn(...args));
mock.method(childProcess, 'execFile', (...args) => fixture.execFile(...args));
const { run } = require('./process.cjs');
const { prepareImages } = require('./images.cjs');

const PIN = { role: 'database', mirror: 'ghcr.io', image: 'example/database', digest: 'sha256:fixture', image_id: 'sha256:image', cli_tag: 'fixture' };
const TOKEN = 'synthetic-test-credential';

function setup(t, { duError = null, duHasTotal = true } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'backend.log');
  const env = { FIXTURE_TOKEN: TOKEN };
  const pulls = []; const kills = []; const diagnostics = []; const messages = [];
  const children = new Map();
  const reference = `${PIN.mirror}/${PIN.image}@${PIN.digest}`;
  let samples = 0;
  let growth = 0;
  let diagnosticError = null;
  for (const level of ['log', 'error', 'warn']) t.mock.method(console, level, text => messages.push(text));
  t.mock.method(process, 'kill', (group, signal) => children.get(-group).kill(signal));
  fixture = {
    spawn(command, args) {
      assert.equal(command, 'docker');
      const child = new EventEmitter();
      child.pid = children.size + 1;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.finish = (status = 0, signal = null) => queueMicrotask(() => child.emit('close', status, signal));
      child.kill = signal => { kills.push({ at: Date.now(), signal }); child.finish(null, signal); };
      children.set(child.pid, child);
      if (args[0] === 'pull') {
        assert.deepEqual(args.slice(0, -1), ['pull', '--platform', 'linux/amd64']);
        assert.ok(args.at(-1).startsWith('ghcr.io/example/'));
        child.reference = args.at(-1);
        pulls.push(child);
      } else {
        queueMicrotask(() => {
          if (args[0] === 'image') child.stdout.write(`${PIN.image_id}\n`);
          child.finish();
        });
      }
      return child;
    },
    execFile(command, args, options, done) {
      assert.equal(options.timeout, 5000);
      if (args[1] === 'du') {
        assert.deepEqual([command, ...args], ['sudo', '-n', 'du', '-sbx', '--', '/fixture/docker']);
        samples++;
        const stdout = duHasTotal ? `${100 + samples * growth}\t/fixture/docker\n` : '';
        queueMicrotask(() => done(duError, stdout, ''));
        return;
      }
      diagnostics.push([command, ...args]);
      const text = command === 'sudo' ? `daemon: ${TOKEN}` : 'daemon info';
      queueMicrotask(() => done(command === 'sudo' ? null : diagnosticError, `${text}\n`, ''));
    },
  };
  return {
    start(pins = [PIN]) {
      return prepareImages(pins.map(pin => ({ ...pin })), { env, logFile, dockerRoot: '/fixture/docker',
        timed: (_label, action) => action(), summary: {}, checked: (command, args, env, timeout, options) =>
          run(command, args, { env, timeout, logFile, ...options }),
      });
    },
    async tick(ms) { t.mock.timers.tick(ms); await flush(); },
    pulls, kills, diagnostics, messages, logFile, reference, samples: () => samples,
    growDisk: () => { growth = 10; }, failInfo: () => { diagnosticError = { code: 1 }; },
  };
}

test('recognized Docker status on either stream allows an attempt past 180s', async t => {
  const f = setup(t);
  const result = f.start();
  const statuses = ['abcd1234: Downloading', 'abcd1234: Verifying Checksum', 'abcd1234: Download complete', 'abcd1234: Extracting',
    'abcd1234: Pull complete', 'abcd1234: Already exists', 'Digest: sha256:fixture', 'Status: Downloaded newer image'];
  for (const [index, status] of statuses.entries()) {
    await f.tick(65000);
    f.pulls[0][index % 2 ? 'stderr' : 'stdout'].write(`${status}\r\n`);
  }
  await f.tick(65000);
  f.pulls[0].stdout.write('Status: Downloaded newer image');
  f.pulls[0].finish();
  await result;
  await f.tick(120000);
  assert.equal(f.pulls.length, 1);
  assert.deepEqual(f.kills, []);
  assert.deepEqual(f.diagnostics, []);
});

test('120s of silence and no disk growth kills, captures diagnostics and retries the same pin', async t => {
  const f = setup(t);
  f.failInfo();
  const result = f.start();
  await f.tick(10000);
  f.pulls[0].stdout.write('abcd1234: Download complete\n');
  await f.tick(119999);
  f.pulls[0].stderr.write('synthetic message unrelated to pull progress\n');
  assert.deepEqual(f.kills, []);
  await f.tick(1);
  assert.deepEqual(f.kills, [{ at: 130000, signal: 'SIGTERM' }]);
  assert.equal(f.pulls.length, 1);
  assert.deepEqual(f.diagnostics, [
    ['sudo', '-n', 'journalctl', '-u', 'docker', '-u', 'containerd', '--since', '-10min', '--no-pager', '-n', '300'],
    ['docker', 'info'],
  ]);
  const report = fs.readFileSync(f.logFile, 'utf8');
  assert.match(report, /example\/database stalled after 120s without progress \(attempt 1\/2\)/);
  assert.match(report, /daemon: \[REDACTED\]/);
  assert.match(report, /Docker info \(capture failed: 1\)/);
  assert.ok(f.messages.some(message => message.includes('daemon: [REDACTED]')));
  assert.ok(!report.includes(TOKEN) && !f.messages.join('\n').includes(TOKEN));
  await f.tick(5000);
  assert.deepEqual(f.pulls.map(child => child.reference), [f.reference, f.reference]);
  f.pulls[1].finish();
  await result;
});

test('shared Docker data-root growth keeps silent pulls alive', async t => {
  const f = setup(t);
  f.growDisk();
  const result = f.start([PIN, { ...PIN, role: 'auth', image: 'example/auth' }]);
  await flush();
  for (let i = 0; i < 16; i++) await f.tick(12000);
  assert.deepEqual(f.kills, []);
  assert.equal(f.samples(), 17);
  for (const child of f.pulls) child.finish();
  await result;
  await f.tick(120000);
  assert.equal(f.samples(), 17);
});

test('failed disk samples leave a silent pull idle for 120s and trigger a retry', async t => {
  const f = setup(t, { duError: { code: 1 }, duHasTotal: false });
  const result = f.start();
  await flush();
  for (let i = 0; i < 9; i++) await f.tick(12000);
  await f.tick(11999);
  assert.deepEqual(f.kills, []);
  await f.tick(1);
  assert.deepEqual(f.kills, [{ at: 120000, signal: 'SIGTERM' }]);
  await f.tick(5000);
  assert.deepEqual(f.pulls.map(child => child.reference), [f.reference, f.reference]);
  f.pulls[1].finish();
  await result;
  assert.equal(f.messages.filter(message => message.includes('Docker data-root sampling unavailable')).length, 1);
});

test('growing disk totals from du exit 1 keep a silent pull alive', async t => {
  const f = setup(t, { duError: { code: 1 } });
  f.growDisk();
  const result = f.start();
  await flush();
  for (let i = 0; i < 16; i++) await f.tick(12000);
  assert.deepEqual(f.kills, []);
  f.pulls[0].finish();
  await result;
});

test('progressing retry is killed at the shared 600s image deadline and captures diagnostics', async t => {
  const f = setup(t);
  const result = f.start();
  const rejected = assert.rejects(result, /example\/database exceeded its 600s overall budget \(attempt 2\/2\)/);
  await f.tick(120000);
  await f.tick(5000);
  for (let i = 0; i < 7; i++) {
    await f.tick(60000);
    f.pulls[1].stdout.write('abcd1234: Extracting\n');
  }
  await f.tick(54999);
  assert.deepEqual(f.kills, [{ at: 120000, signal: 'SIGTERM' }]);
  await f.tick(1);
  await rejected;
  assert.deepEqual(f.kills.map(kill => kill.at), [120000, 600000]);
  assert.equal(f.pulls.length, 2);
  assert.equal(f.diagnostics.length, 4);
  assert.match(fs.readFileSync(f.logFile, 'utf8'), /exceeded its 600s overall budget/);
});
