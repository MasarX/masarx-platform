'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const { retry } = require('../ci-hosted/process.cjs');
const { checkPreview } = require('../deploy/dev-label-render-probe.cjs');
const { FINAL_PULL_ERROR, TRANSIENT_PULL_ERROR } = require('../ops/ci/cloud-pool-db-local.js');
const { resolveEdgeRuntimeCacheImage } = require('./verify-npm-import-lock.js');

const root = path.resolve(__dirname, '../..');
const gateway = path.join(__dirname, 'fixtures/label-renderer-preview');
const dockerTimeoutMs = 120_000;
const safeMessages = [
  [/cannot access .+ before initialization/i, 'Cannot access binding before initialization'],
  [/cannot read properties of (undefined|null)/i, 'Cannot read properties of a missing value'],
  [/dynamic require|require is not defined/i, 'CommonJS require unavailable'],
  [/module not found|cannot find module/i, 'Module not found'],
  [/maximum call stack size exceeded/i, 'Maximum call stack size exceeded'],
  [/no native websocket implementation|websocket is not defined/i, 'WebSocket unavailable'],
  [/worker boot error/i, 'Worker boot error'],
];
const safeDockerMessages = [
  [/no space left on device/i, 'Docker storage is full'],
  [/manifest unknown|no matching manifest|no such image/i, 'Image or platform unavailable'],
  [/unauthorized|pull access denied|requested access .* denied|authentication required|403 Forbidden/i, 'Registry access denied'],
  [/cannot connect to the docker daemon|is the docker daemon running/i, 'Docker daemon unavailable'],
  [/invalid mount config|bind source path does not exist/i, 'Invalid container mount'],
  [/port is already allocated|address already in use/i, 'Container port unavailable'],
  [/OCI runtime|failed to (?:create task|start container)/i, 'Container startup failed'],
  [TRANSIENT_PULL_ERROR, 'Registry or network error'],
];

function docker(args, timeout = dockerTimeoutMs) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
}

function formatDockerFailure(result) {
  // Use fixed messages so values embedded anywhere in Docker output stay private.
  const excerpt = (result.stderr ?? '').trim().split(/\r\n?|\n/).filter(Boolean).slice(-20)
    .map(line => safeDockerMessages.find(([pattern]) => pattern.test(line))?.[1] ?? 'redacted');
  const code = result.error?.code;
  const spawnError = ['EACCES', 'ENOENT', 'ENOBUFS', 'ETIMEDOUT'].includes(code) ? code : result.error ? 'redacted' : 'none';
  return `exit_status=${result.status ?? 'unavailable'} spawn_error=${spawnError} stderr=${JSON.stringify(excerpt)}`;
}

async function pullRuntimeImage(image) {
  const deadline = performance.now() + dockerTimeoutMs;
  const remainingMs = () => Math.max(0, Math.floor(deadline - performance.now()));
  await retry('label renderer image pull', async attempt => {
    const timeout = remainingMs();
    if (!timeout) throw new Error('runtime_image_pull_timeout');
    const result = docker(['pull', '--platform', 'linux/amd64', image], timeout);
    if (result.status === 0) return;
    console.error(`LABEL_RENDERER_EDGE_DOCKER stage=runtime_image_pull attempt=${attempt} ${formatDockerFailure(result)}`);
    const stderr = result.stderr ?? '';
    const transient = !result.error && !FINAL_PULL_ERROR.test(stderr) && TRANSIENT_PULL_ERROR.test(stderr);
    throw new Error(transient ? 'transient_runtime_image_pull' : 'runtime_image_pull');
  }, delay => wait(Math.min(delay, remainingMs())), {
    quiet: true,
    retryable: error => error.message === 'transient_runtime_image_pull' && remainingMs() > 0,
  });
}

function waitForRuntime(container) {
  return new Promise((resolve, reject) => {
    const logs = spawn('docker', ['logs', '--follow', container], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => {
      logs.kill();
      reject(new Error('runtime_start_timeout'));
    }, 30_000);
    let tail = '';
    function observe(chunk) {
      tail = (tail + chunk).slice(-8192);
      if (tail.includes('edge-runtime is listening on')) {
        logs.kill();
        resolve();
      }
    }
    logs.stdout.on('data', observe);
    logs.stderr.on('data', observe);
    logs.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('runtime_logs_unavailable'));
    });
    logs.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('runtime_exited'));
    });
  });
}

function reportWorkerError(container, responseMessage) {
  const logs = container ? docker(['logs', container]) : {};
  const detail = [responseMessage, logs.stdout, logs.stderr].filter(Boolean).join('\n');
  const errorClass = detail.match(/\b(TypeError|ReferenceError|SyntaxError|RangeError|AggregateError|WorkerRequestCancelled|InvalidWorkerCreation|Error):/)?.[1]
    ?? 'unavailable';
  const message = safeMessages.find(([pattern]) => pattern.test(detail))?.[1] ?? 'redacted';
  const frames = [...new Set(Array.from(
    detail.matchAll(/\b(renderer|gateway)\/(index\.ts):(\d{1,6}):(\d{1,8})\b/g),
    ([, location, file, line, column]) => `${location}/${file}:${line}:${column}`,
  ))].slice(0, 8);
  console.error(`LABEL_RENDERER_EDGE_ERROR class=${errorClass} message=${message} frames=${frames.join(',') || 'unavailable'}`);
}

async function main(pullOnly) {
  let container;
  let responseMessage;
  let stage = 'bundle_input';
  try {
    let renderer;
    if (!pullOnly) {
      if (!process.env.EDGE_FROZEN_WORKDIR) throw new Error(stage);
      renderer = path.resolve(process.env.EDGE_FROZEN_WORKDIR, 'supabase/functions/label-renderer');
      if (!fs.statSync(path.join(renderer, 'index.ts'), { throwIfNoEntry: false })?.isFile()) throw new Error(stage);
    }

    stage = 'runtime_image';
    const image = resolveEdgeRuntimeCacheImage(root, { SUPABASE_CLI_VERSION: '2.116.0' }, fs);
    if (pullOnly) {
      stage = 'runtime_image_pull';
      await pullRuntimeImage(image);
      return;
    }

    stage = 'runtime_container';
    const started = docker([
      'run', '--pull=never', '--detach', '--init', '--platform', 'linux/amd64', '--publish', '127.0.0.1::9000',
      '--mount', `type=bind,source=${renderer},target=/renderer,readonly`,
      '--mount', `type=bind,source=${gateway},target=/gateway,readonly`,
      image, 'start', '--verbose', '--main-service', '/gateway',
    ]);
    const id = started.stdout?.trim();
    if (started.status !== 0 || !/^[a-f0-9]{64}$/.test(id ?? '')) {
      console.error(`LABEL_RENDERER_EDGE_DOCKER stage=${stage} ${formatDockerFailure(started)}`);
      throw new Error(stage);
    }
    container = id;
    stage = 'runtime_ready';
    await waitForRuntime(container);

    stage = 'runtime_port';
    const published = docker(['port', container, '9000/tcp']);
    const port = published.stdout?.trim().match(/^127\.0\.0\.1:(\d{1,5})$/)?.[1];
    if (published.status !== 0 || !port) throw new Error(stage);

    stage = 'preview_request';
    const userJwt = randomUUID();
    const response = await fetch(`http://127.0.0.1:${port}/functions/v1/label-renderer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userJwt}`,
        apikey: randomUUID(),
      },
      body: JSON.stringify({
        mode: 'designer_preview', user_jwt: userJwt, label_type: 'shipping',
        draft_id: randomUUID(), shipment_id: randomUUID(), shipment_box_id: randomUUID(),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    responseMessage = typeof body?.error?.message === 'string' ? body.error.message : undefined;
    const preview = checkPreview(response.status, body);
    const marked = response.headers.get('x-masarx-renderer-transport') === '1';
    if (preview.code || !marked) {
      console.error(`LABEL_RENDERER_EDGE_FAIL status=${response.status} handler=${marked} probe_code=${preview.code}`);
      throw new Error(stage);
    }
    console.log(`LABEL_RENDERER_EDGE_PASS status=200 pdf_bytes=${preview.pdfBytes}`);
  } catch {
    console.error(`LABEL_RENDERER_EDGE_FAIL stage=${stage}`);
    reportWorkerError(container, responseMessage);
    process.exitCode = 1;
  } finally {
    if (container && docker(['rm', '--force', container]).status !== 0) {
      console.error('LABEL_RENDERER_EDGE_FAIL stage=runtime_cleanup');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) void main(process.argv[2] === '--pull');

module.exports = { formatDockerFailure };
