#!/usr/bin/env node
/* eslint-disable no-console */
const { spawn, spawnSync } = require('child_process');
const toolchain = require('./pr-validation-pg-prove-toolchain');

const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function expectedContainerIdentity(options = {}) {
  const loaded = options.loaded;
  const imageId = String(options.imageId || '');
  const phase = String(options.phase || '');
  if (!loaded || !/^sha256:[a-f0-9]{64}$/u.test(imageId)
    || !/^(?:parallel_wave|isolated_rerun|serial_quarantine)$/u.test(phase)) {
    throw new Error('focused_pg_prove_toolchain_container_identity_invalid');
  }
  return {
    imageId,
    labels: {
      'org.masarx.resource-class': 'pr-validation-pg-prove-runner',
      'org.masarx.phase': phase,
      'org.masarx.pg-prove.policy-sha256': loaded.policySha256,
      'org.masarx.pg-prove.dockerfile-sha256': loaded.dockerfileSha256,
    },
  };
}

function confirmedContainerNotFound(result, name) {
  const stdout = String(result.stdout || '').trim();
  if (result.error || result.status !== 1 || (stdout && stdout !== '[]')) return false;
  const escapedName = escapeRegExp(name);
  return new RegExp(`(?:No such (?:container|object):\\s*|No such container\\s+)${escapedName}\\s*$`, 'iu')
    .test(String(result.stderr || ''));
}

function inspectExactContainer(name, expected, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const timeout = Math.max(1, Number(options.timeoutMs || 5000));
  const result = spawnSyncImpl('docker', ['container', 'inspect', name], {
    encoding: 'utf8', windowsHide: true, timeout,
  });
  if (confirmedContainerNotFound(result, name)) return { state: 'absent' };
  if (result.error || result.status !== 0) {
    return {
      state: 'ambiguous',
      reason: result.error?.code === 'ETIMEDOUT' ? 'inspect_timeout' : 'inspect_failed',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || ''));
  } catch {
    return { state: 'ambiguous', reason: 'inspect_payload_invalid' };
  }
  const container = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  if (!container || !CONTAINER_ID_PATTERN.test(String(container.Id || ''))) {
    return { state: 'ambiguous', reason: 'inspect_payload_invalid' };
  }
  const labels = container.Config?.Labels || {};
  const mismatches = [];
  if (String(container.Name || '') !== `/${name}`) mismatches.push('name');
  if (String(container.Image || '') !== expected.imageId) mismatches.push('image_id');
  for (const [key, value] of Object.entries(expected.labels || {})) {
    if (String(labels[key] || '') !== value) mismatches.push(key);
  }
  if (mismatches.length) {
    return { state: 'ambiguous', reason: 'identity_mismatch', mismatches };
  }
  return { state: 'matching', containerId: String(container.Id) };
}

function remainingMs(deadlineMs, nowImpl = Date.now) {
  return Math.max(0, Number(deadlineMs) - nowImpl());
}

function removeExactContainer(name, expected, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const nowImpl = options.nowImpl || Date.now;
  const deadlineMs = Number(options.deadlineMs || (nowImpl() + 5000));
  const inspectBudget = remainingMs(deadlineMs, nowImpl);
  if (!inspectBudget) return { state: 'ambiguous', reason: 'cleanup_deadline_exhausted' };
  const inspection = inspectExactContainer(name, expected, {
    spawnSyncImpl,
    timeoutMs: inspectBudget,
  });
  if (inspection.state !== 'matching') return inspection;
  const removeBudget = remainingMs(deadlineMs, nowImpl);
  if (!removeBudget) return { state: 'ambiguous', reason: 'cleanup_deadline_exhausted' };
  const result = spawnSyncImpl('docker', ['rm', '--force', inspection.containerId], {
    encoding: 'utf8', windowsHide: true, timeout: removeBudget,
  });
  if (result.error || result.status !== 0) {
    return {
      state: 'ambiguous',
      reason: result.error?.code === 'ETIMEDOUT' ? 'remove_timeout' : 'remove_failed',
    };
  }
  return { state: 'remove_requested', containerId: inspection.containerId };
}

function parseCli(argv) {
  const out = { command: String(argv[0] || ''), cwd: process.cwd(), stateDirectory: '', phase: '', timeoutMs: 0, logicalArgs: [] };
  let index = 1;
  for (; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--') {
      out.logicalArgs = argv.slice(index + 1).map(String);
      break;
    }
    const value = () => String(argv[++index] || '');
    if (token === '--cwd') out.cwd = value();
    else if (token === '--state-directory') out.stateDirectory = value();
    else if (token === '--phase') out.phase = value();
    else if (token === '--timeout-ms') out.timeoutMs = Number(value());
    else throw new Error(`Unknown pg_prove toolchain argument: ${token}`);
  }
  return out;
}

function runChild(command, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code == null ? 1 : code, signal: String(signal || '') }));
  });
}

async function waitForContainerRemoval(name, expected, deadlineMs, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const nowImpl = options.nowImpl || Date.now;
  const sleepImpl = options.sleepImpl || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  while (remainingMs(deadlineMs, nowImpl) > 0) {
    const inspection = inspectExactContainer(name, expected, {
      spawnSyncImpl,
      timeoutMs: Math.min(1000, remainingMs(deadlineMs, nowImpl)),
    });
    if (inspection.state === 'absent') return { removed: true, inspection };
    if (inspection.state === 'ambiguous') return { removed: false, inspection };
    const delay = Math.min(100, remainingMs(deadlineMs, nowImpl));
    if (delay > 0) await sleepImpl(delay);
  }
  return { removed: false, inspection: { state: 'ambiguous', reason: 'cleanup_deadline_exhausted' } };
}

async function cleanupExactContainer(name, expected, waitMs, options = {}) {
  const nowImpl = options.nowImpl || Date.now;
  const deadlineMs = nowImpl() + Number(waitMs);
  const removal = removeExactContainer(name, expected, { ...options, deadlineMs, nowImpl });
  if (removal.state === 'absent') return { removed: true, inspection: removal };
  if (removal.state !== 'remove_requested') return { removed: false, inspection: removal };
  return waitForContainerRemoval(name, expected, deadlineMs, { ...options, nowImpl });
}

async function prepare(cwd) {
  const loaded = toolchain.loadPolicy(cwd);
  try {
    const existing = toolchain.inspectImage(loaded);
    console.log(JSON.stringify({ status: 'already_prepared', ...existing }));
    return 0;
  } catch (error) {
    if (!String(error?.message || error).startsWith('focused_pg_prove_toolchain_')) throw error;
  }
  const build = toolchain.buildImageCommand(loaded);
  const outcome = await runChild(build.command, build.args, { cwd: loaded.cwd });
  if (outcome.code !== 0) throw new Error(`pg_prove toolchain image build failed with exit ${outcome.code}.`);
  const verified = toolchain.inspectImage(loaded);
  const selfCheck = await runChild('docker', [
    'run', '--rm', '--pull', 'never', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', loaded.policy.runner.user,
    loaded.policy.image.tag,
    'sh', '-ceu',
    `test "$(pg_prove --version)" = "pg_prove ${loaded.policy.image.pg_prove_version}" && test "$(psql --version | awk '{print $3}' | cut -d. -f1)" = "${loaded.policy.image.psql_major}"`,
  ], { cwd: loaded.cwd });
  if (selfCheck.code !== 0) throw new Error(`pg_prove toolchain self-check failed with exit ${selfCheck.code}.`);
  console.log(JSON.stringify({ status: 'prepared', ...verified }));
  return 0;
}

async function run(options) {
  const loaded = toolchain.loadPolicy(options.cwd);
  const image = toolchain.inspectImage(loaded);
  if (!process.env.PGPASSWORD) throw new Error('focused_pg_prove_toolchain_missing_pgpassword');
  const docker = toolchain.buildDockerRunCommand({
    loaded,
    imageId: image.imageId,
    stateDirectory: options.stateDirectory,
    phase: options.phase,
    timeoutMs: options.timeoutMs,
    logicalArgs: options.logicalArgs,
  });
  const identity = expectedContainerIdentity({ loaded, imageId: image.imageId, phase: options.phase });
  const preflight = inspectExactContainer(docker.containerName, identity, {
    timeoutMs: loaded.policy.runner.cleanup_wait_ms,
  });
  if (preflight.state === 'matching') {
    throw new Error('focused_pg_prove_toolchain_container_name_already_active');
  }
  if (preflight.state !== 'absent') throw new Error(`focused_pg_prove_toolchain_container_preflight_${preflight.reason}`);
  console.log(`${toolchain.START_MARKER} image=${image.imageId} policy=${loaded.policySha256} dockerfile=${loaded.dockerfileSha256} container=${docker.containerName}`);
  let outcome = { code: 125, signal: '' };
  let runError = null;
  try {
    outcome = await runChild(docker.command, docker.args, { cwd: loaded.cwd });
  } catch (error) {
    runError = error;
  }
  const cleanup = await cleanupExactContainer(
    docker.containerName,
    identity,
    loaded.policy.runner.cleanup_wait_ms,
  );
  console.log(`${toolchain.DONE_MARKER} image=${image.imageId} policy=${loaded.policySha256} dockerfile=${loaded.dockerfileSha256} container=${docker.containerName} residual=${cleanup.removed ? 0 : 1} exit=${outcome.code}`);
  if (!cleanup.removed) return 125;
  if (runError) throw runError;
  return outcome.code;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.command === 'prepare') return prepare(options.cwd);
  if (options.command === 'verify') {
    const loaded = toolchain.loadPolicy(options.cwd);
    console.log(JSON.stringify({ status: 'verified', ...toolchain.inspectImage(loaded) }));
    return 0;
  }
  if (options.command === 'run') return run(options);
  throw new Error('Expected pg_prove toolchain command: prepare, verify, or run.');
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`MASARX_PG_PROVE_TOOLCHAIN_ERROR ${error?.message || String(error)}`);
    process.exitCode = 125;
  });
}

module.exports = {
  cleanupExactContainer,
  confirmedContainerNotFound,
  expectedContainerIdentity,
  inspectExactContainer,
  main,
  parseCli,
  prepare,
  removeExactContainer,
  run,
  runChild,
  waitForContainerRemoval,
};
