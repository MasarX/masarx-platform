#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  waitForConsoleListener,
} = require('./local-console-runtime');

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLandingRuntimePaths(cwd = process.cwd(), port = 3333) {
  const runtimeDir = path.join(cwd, 'tmp', 'local-landing');
  return {
    runtimeDir,
    pidPath: path.join(runtimeDir, `landing-${port}.pid`),
    outLogPath: path.join(runtimeDir, `landing-${port}.out.log`),
    errLogPath: path.join(runtimeDir, `landing-${port}.err.log`),
  };
}

function readPid(pidPath) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch (_) {
    return 0;
  }
}

function isProcessRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function startLandingRuntime(options = {}) {
  const cwd = options.cwd || process.cwd();
  const port = parsePositiveInteger(options.port, 3333);
  const host = options.host || '127.0.0.1';
  const landingSiteUrl = `http://${host}:${port}`;
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawnImpl || spawn;
  const existingListener = await waitForConsoleListener({
    host,
    port,
    timeoutMs: parsePositiveInteger(options.reuseProbeTimeoutMs, 1000),
    intervalMs: parsePositiveInteger(options.intervalMs, 500),
  });
  if (existingListener.ok) {
    return { ok: true, reused: true, pid: 0, listener: existingListener };
  }

  const paths = getLandingRuntimePaths(cwd, port);
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  const args = ['run', 'dev:landing', '--', '--port', String(port)];
  const command = platform === 'win32'
    ? { command: 'cmd.exe', args: ['/c', 'npm', ...args] }
    : { command: 'npm', args };
  const outFd = fs.openSync(paths.outLogPath, 'a');
  const errFd = fs.openSync(paths.errLogPath, 'a');
  let child;
  try {
    child = spawnImpl(command.command, command.args, {
      cwd,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      env: {
        ...process.env,
        ...(options.env || {}),
        LANDING_HOST: host,
        LANDING_PORT: String(port),
        LANDING_SITE_URL: options.env?.LANDING_SITE_URL || landingSiteUrl,
        VITE_USE_SEED: 'false',
      },
    });
  } finally {
    try { fs.closeSync(outFd); } catch (_) { /* no-op */ }
    try { fs.closeSync(errFd); } catch (_) { /* no-op */ }
  }
  if (typeof child.unref === 'function') child.unref();
  fs.writeFileSync(paths.pidPath, `${child.pid}\n`, 'utf8');
  return { ok: true, reused: false, pid: child.pid, listener: null, paths };
}

function stopLandingRuntime(options = {}) {
  const cwd = options.cwd || process.cwd();
  const port = parsePositiveInteger(options.port, 3333);
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const paths = getLandingRuntimePaths(cwd, port);
  const pid = readPid(paths.pidPath);
  let killed = false;
  if (pid && isProcessRunning(pid)) {
    if (platform === 'win32') {
      const res = spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killed = res.status === 0;
    } else {
      try {
        process.kill(pid, 'SIGTERM');
        killed = true;
      } catch (_) {
        killed = false;
      }
    }
  }
  try {
    fs.unlinkSync(paths.pidPath);
  } catch (_) {
    // no-op
  }
  return { ok: true, running: Boolean(pid), pid, killed };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { command: 'start' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (!token.startsWith('--') && index === 0) {
      out.command = token;
      continue;
    }
    const key = token.replace(/^--/, '');
    const next = argv[index + 1];
    if (next == null || String(next).startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const port = parsePositiveInteger(args.port || process.env.LANDING_PORT, 3333);
  if (args.command === 'stop') {
    console.log(JSON.stringify(stopLandingRuntime({ port }), null, 2));
    return;
  }
  const result = await startLandingRuntime({
    port,
    host: args.host || '127.0.0.1',
    timeoutMs: parsePositiveInteger(args['timeout-ms'], 120000),
    intervalMs: parsePositiveInteger(args['interval-ms'], 500),
  });
  const listener = result.listener?.ok
    ? result.listener
    : await waitForConsoleListener({
      host: args.host || '127.0.0.1',
      port,
      timeoutMs: parsePositiveInteger(args['timeout-ms'], 120000),
      intervalMs: parsePositiveInteger(args['interval-ms'], 500),
    });
  console.log(JSON.stringify({
    ok: Boolean(result.ok && listener.ok),
    reused: result.reused,
    pid: result.pid,
    listener,
    url: `http://${args.host || '127.0.0.1'}:${port}`,
  }, null, 2));
  if (!listener.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`local-landing-runtime: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  getLandingRuntimePaths,
  startLandingRuntime,
  stopLandingRuntime,
};
