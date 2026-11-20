'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { retry } = require('./process.cjs');
const { environmentSecrets, outputTail, sanitize } = require('./diagnostics.cjs');
const { TRANSIENT_PULL_ERROR, FINAL_PULL_ERROR } = require('../ops/ci/cloud-pool-db-local.js');

const PULL_IDLE_MS = 120000;
const PULL_BUDGET_MS = 600000;
const PULL_ATTEMPTS = 2;
const PULL_STATUS = /^(?:[a-f0-9]+:\s+(?:Downloading|Download complete|Extracting|Pull complete|Verifying Checksum|Already exists)\b|(?:Digest|Status):)/i;
const alias = pin => `public.ecr.aws/${pin.image}:${pin.cli_tag}`;

function readCommand(command, args, env) {
  return new Promise(resolve => execFile(command, args, { env, timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}

async function filesystemUsed(dockerRoot, env) {
  try {
    const { blocks, bfree, bsize } = await fs.promises.statfs(dockerRoot);
    return (blocks - bfree) * bsize;
  } catch (statError) {
    const { error, stdout } = await readCommand('df', ['-B1', '--output=used', '--', dockerRoot], env);
    const total = stdout.trim().split('\n').at(-1).trim();
    if (/^\d+$/.test(total)) return Number(total);
    throw new Error(`statfs: ${statError.message}; df: ${error?.code ?? error?.signal ?? 'no numeric used-byte total'}`);
  }
}

function watchDiskGrowth(dockerRoot, env) {
  const pulls = new Set();
  let timer; let sampling; let previousBytes; let warned = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const bytes = await filesystemUsed(dockerRoot, env);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid used-byte total');
      // Growth from other writers on this filesystem can also reset the idle timer.
      if (bytes > previousBytes) for (const progress of pulls) progress();
      previousBytes = bytes;
    } catch (error) {
      if (!warned) {
        const cause = sanitize(error.message, environmentSecrets(env)).replace(/[\r\n]+/g, ' ');
        console.warn(`Docker data-root sampling unavailable; treating missing samples as no growth: ${cause}`);
        warned = true;
      }
      previousBytes = undefined;
    } finally { sampling = false; }
  };
  // One filesystem sample serves all concurrent pulls.
  return progress => {
    pulls.add(progress);
    if (!timer) { timer = setInterval(sample, 12000); void sample(); }
    return () => {
      pulls.delete(progress);
      if (!pulls.size) { clearInterval(timer); timer = undefined; previousBytes = undefined; }
    };
  };
}

async function capturePullDiagnostics(env, logFile, label, reason) {
  const secrets = environmentSecrets(env);
  const commands = [
    ['sudo', ['-n', 'journalctl', '-u', 'docker', '-u', 'containerd', '--since', '-10min', '--no-pager', '-n', '300'], 'Docker/containerd journal'],
    ['docker', ['info'], 'Docker info'],
  ];
  try {
    const entries = await Promise.all(commands.map(async ([command, args, title]) => {
      const { error, stdout, stderr } = await readCommand(command, args, env);
      const status = error ? ` (capture failed: ${error.code ?? error.signal ?? 'unknown'})` : '';
      return `${title}${status}\n${outputTail(`${stdout}\n${stderr}`.trimEnd(), secrets, 300, 32768)}`;
    }));
    const report = [reason, ...entries].join('\n').split('\n').map(line => `[${label}] ${sanitize(line, secrets)}`).join('\n');
    console.log(report);
    fs.appendFileSync(logFile, `${report}\n`);
  } catch (error) {
    console.warn(`Image pull diagnostics unavailable: ${sanitize(error.message, secrets)}`);
  }
}

async function prepareImages(pins, { env, checked, timed, summary, wait, dockerRoot, logFile, checkDisk = () => {} }) {
  const subscribeProgress = dockerRoot ? watchDiskGrowth(dockerRoot, env) : undefined;
  const inspect = async (reference, pin) => {
    const id = (await checked('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], env, 30000, { quiet: true })).trim();
    if (id !== pin.image_id) throw new Error(`Reviewed image ID mismatch: ${pin.image}`);
    return id;
  };
  const results = await Promise.allSettled(pins.map(async pin => {
    checkDisk();
    const served = pin.mirror;
    const reference = `${served}/${pin.image}@${pin.digest}`;
    const label = `image-pull:${pin.role}:${served}`;
    const deadline = Date.now() + PULL_BUDGET_MS;
    const budgetMessage = `Image pull ${pin.image} exceeded its ${PULL_BUDGET_MS / 1000}s overall budget`;
    await timed(label, () => retry(label, async attempt => {
      const timeout = deadline - Date.now();
      if (timeout <= 0) throw new Error(budgetMessage);
      let stalled = false;
      try {
        await checked('docker', ['pull', '--platform', 'linux/amd64', reference], env, timeout, {
          logPrefix: `[${label}] `, idleMs: PULL_IDLE_MS, subscribeProgress, onLine: line => PULL_STATUS.test(line),
          idleMessage: elapsed => {
            stalled = true;
            return `Image pull ${pin.image} stalled after ${Math.floor(elapsed / 1000)}s without progress (attempt ${attempt}/${PULL_ATTEMPTS})`;
          },
        });
      } catch (error) {
        if (!error.failure?.timeout) throw error;
        if (!stalled && Date.now() >= deadline) {
          const budgetError = new Error(`${budgetMessage} (attempt ${attempt}/${PULL_ATTEMPTS})`, { cause: error });
          budgetError.failure = error.failure;
          error = budgetError;
        }
        if (logFile) await capturePullDiagnostics(env, logFile, label, error.message);
        throw error;
      }
    }, wait, {
      attempts: PULL_ATTEMPTS,
      retryable(error) {
        const output = `${error.message}\n${error.failure?.output || ''}`;
        return Date.now() < deadline && !FINAL_PULL_ERROR.test(output) && (error.failure?.timeout || TRANSIENT_PULL_ERROR.test(output));
      },
    }));
    pin.runtimeId = await inspect(reference, pin);
    await checked('docker', ['tag', pin.runtimeId, alias(pin)], env, 30000);
    console.log(`Reviewed image ${pin.image}@${pin.digest} served by ${served}; verified ${pin.runtimeId}`);
    return { image: pin.image, digest: pin.digest, id: pin.runtimeId, served };
  }));
  summary.images = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
module.exports = { prepareImages };
