#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readEnvFile } = require('../../utils/env-file');

const DEFAULT_LOG_TAIL_LIMIT = 8000;
const SENSITIVE_ENV_KEY_RE = /(SECRET|TOKEN|PASSWORD|PASS|KEY|SERVICE_ROLE|JWT|DATABASE_URL|DB_URL)/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const DATABASE_URL_RE = /\bpostgres(?:ql)?:\/\/[^\s\r\n\u2502|]+/gi;
const SUPABASE_KEY_RE = /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/g;
const LABELED_SECRET_RE = /((?:service[_ -]?role|secret|password|token|api[_ -]?key|anon[_ -]?key|jwt|database[_ -]?url|publishable|access[_ -]?key|secret[_ -]?key)[^\r\n:=\u2502|]{0,40}(?:[:=]|[\u2502|])\s*)([^\s\r\n\u2502|]+)/gi;

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function getConsoleRuntimePaths(cwd = process.cwd(), port = 5175) {
  const runtimeDir = path.join(cwd, 'tmp', 'local-console');
  return {
    runtimeDir,
    appDir: path.join(cwd, 'apps', 'console'),
    envPath: path.join(cwd, 'config', 'env', '.env.local'),
    pidPath: path.join(runtimeDir, `console-v2-${port}.pid`),
    outLogPath: path.join(runtimeDir, `console-v2-${port}.out.log`),
    errLogPath: path.join(runtimeDir, `console-v2-${port}.err.log`),
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

function redactConsoleRuntimeText(value, env = process.env) {
  let output = String(value || '');
  for (const [key, rawValue] of Object.entries(env || {})) {
    const secretValue = String(rawValue || '');
    if (!SENSITIVE_ENV_KEY_RE.test(key) || secretValue.length < 8) continue;
    output = output.split(secretValue).join(`[redacted:${key}]`);
  }
  return output
    .replace(JWT_RE, '[redacted-jwt]')
    .replace(DATABASE_URL_RE, '[redacted-database-url]')
    .replace(SUPABASE_KEY_RE, '[redacted-supabase-key]')
    .replace(LABELED_SECRET_RE, '$1[redacted]');
}

function readConsoleLogTail(filePath, options = {}) {
  const limit = parsePositiveInteger(options.limit, DEFAULT_LOG_TAIL_LIMIT);
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      text: '',
      exists: false,
      truncated: false,
      original_length: 0,
      redacted: false,
    };
  }
  const stat = fs.statSync(filePath);
  const bytesToRead = limit > 0 ? Math.min(stat.size, limit * 2) : stat.size;
  const fd = fs.openSync(filePath, 'r');
  let raw = '';
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
    raw = buffer.toString('utf8');
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* no-op */ }
  }
  const redacted = redactConsoleRuntimeText(raw, options.env || process.env);
  const text = limit > 0 && redacted.length > limit ? redacted.slice(-limit) : redacted;
  return {
    text,
    exists: true,
    truncated: text.length < redacted.length || bytesToRead < stat.size,
    original_length: stat.size,
    redacted: redacted !== raw,
  };
}

function buildConsoleDevCommand({ appDir, port, host = '127.0.0.1', platform = process.platform } = {}) {
  const args = [
    '--prefix',
    appDir,
    'exec',
    '--',
    'next',
    'dev',
    '-H',
    host,
    '-p',
    String(port),
  ];
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/c', 'npm', ...args] };
  }
  return { command: 'npm', args };
}

function resolveConsoleEnv({ cwd = process.cwd(), env = process.env, envPath } = {}) {
  const resolvedEnvPath = envPath || getConsoleRuntimePaths(cwd).envPath;
  if (!fs.existsSync(resolvedEnvPath)) {
    throw new Error(`missing_local_env:${resolvedEnvPath}`);
  }
  const parsed = readEnvFile(resolvedEnvPath) || {};
  return {
    ...env,
    ...parsed,
    NEXT_PUBLIC_USE_SEED: 'false',
    VITE_USE_SEED: 'false',
  };
}

function canConnectToPort({ host = '127.0.0.1', port, timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForConsoleListener({
  host = '127.0.0.1',
  port,
  timeoutMs = 60000,
  intervalMs = 500,
  connectImpl = canConnectToPort,
} = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (await connectImpl({ host, port, timeoutMs: Math.min(intervalMs, 1000) })) {
      return { ok: true, host, port, waited_ms: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, host, port, waited_ms: Date.now() - started, reason: 'console_listener_timeout' };
}

function quotePowerShellLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function stopOrphanedConsoleRuntime(options = {}) {
  const cwd = options.cwd || process.cwd();
  const port = parsePositiveInteger(options.port, 5175);
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const logger = options.logger || console;
  if (platform !== 'win32') {
    return { attempted: false, killed: 0, pids: [] };
  }
  const appDir = path.resolve(getConsoleRuntimePaths(cwd, port).appDir);
  const appDirForward = appDir.replace(/\\/g, '/');
  const script = [
    `$needles = @(${quotePowerShellLiteral(appDir)}, ${quotePowerShellLiteral(appDirForward)})`,
    `$port = ${port}`,
    '$matches = Get-CimInstance Win32_Process | Where-Object {',
    '  $cmd = [string]$_.CommandLine',
    '  ($cmd -match "npm(\\.cmd)?\\s+--prefix" -or $cmd -match "next\\s+dev") -and',
    '    ($needles | Where-Object { $cmd.Contains($_) }) -and',
    '    ($cmd -match ("(-p|--port)\\s+" + $port))',
    '}',
    '$ids = @($matches | Select-Object -ExpandProperty ProcessId -Unique)',
    'foreach ($id in $ids) { & taskkill /PID $id /T /F | Out-Null }',
    '$ids -join ","',
  ].join('; ');
  const res = spawnSyncImpl('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  }) || {};
  const pids = String(res.stdout || '')
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  if (pids.length) {
    logger.log(`[workspace/local-console] Stopped orphaned Console runtime pids=${pids.join(',')}`);
  }
  return {
    attempted: true,
    killed: pids.length,
    pids,
    status: typeof res.status === 'number' ? res.status : null,
  };
}

function buildConsoleRuntimeFailure({
  cwd,
  host,
  port,
  command,
  child,
  paths,
  listener,
  env,
  stopResult,
  processRunningBeforeStop = false,
  logTailLimit,
} = {}) {
  const stdout = readConsoleLogTail(paths?.outLogPath, { env, limit: logTailLimit });
  const stderr = readConsoleLogTail(paths?.errLogPath, { env, limit: logTailLimit });
  return {
    ok: false,
    reason: 'console_listener_timeout',
    command: command?.command || '',
    args: command?.args || [],
    cwd,
    pid: child?.pid || 0,
    process_running_before_stop: Boolean(processRunningBeforeStop),
    process_running_after_stop: child?.pid ? isProcessRunning(child.pid) : false,
    listener,
    paths,
    stdout_tail: stdout.text,
    stderr_tail: stderr.text,
    stdout_tail_truncated: stdout.truncated,
    stderr_tail_truncated: stderr.truncated,
    stdout_log_exists: stdout.exists,
    stderr_log_exists: stderr.exists,
    stdout_log_length: stdout.original_length,
    stderr_log_length: stderr.original_length,
    output_redacted: stdout.redacted || stderr.redacted,
    stop_result: stopResult || null,
    url: `http://${host}:${port}`,
  };
}

async function startConsoleRuntime(options = {}) {
  const cwd = options.cwd || process.cwd();
  const port = parsePositiveInteger(options.port, 5175);
  const host = options.host || '127.0.0.1';
  const logger = options.logger || console;
  const spawnImpl = options.spawnImpl || spawn;
  const waitForListenerImpl = options.waitForListenerImpl || waitForConsoleListener;
  const paths = getConsoleRuntimePaths(cwd, port);
  if (!fs.existsSync(paths.appDir)) {
    throw new Error(`missing_console_app:${paths.appDir}`);
  }
  const env = resolveConsoleEnv({ cwd, env: options.env || process.env, envPath: paths.envPath });
  ensureDir(paths.runtimeDir);
  const existingPid = readPid(paths.pidPath);
  if (existingPid && isProcessRunning(existingPid)) {
    const listener = await waitForListenerImpl({
      host,
      port,
      timeoutMs: parsePositiveInteger(options.timeoutMs, 5000),
      intervalMs: parsePositiveInteger(options.intervalMs, 500),
    });
    if (listener.ok) {
      logger.log(`[workspace/local-console] Runtime already running pid=${existingPid} port=${port}`);
      return { ok: true, reused: true, pid: existingPid, listener, paths };
    }
  }

  stopOrphanedConsoleRuntime({
    cwd,
    port,
    logger,
    spawnSyncImpl: options.spawnSyncImpl || spawnSync,
    platform: options.platform,
  });

  const outFd = fs.openSync(paths.outLogPath, 'a');
  const errFd = fs.openSync(paths.errLogPath, 'a');
  const command = buildConsoleDevCommand({
    appDir: paths.appDir,
    port,
    host,
    platform: options.platform || process.platform,
  });
  let child;
  try {
    child = spawnImpl(command.command, command.args, {
      cwd,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      env,
    });
  } finally {
    try { fs.closeSync(outFd); } catch (_) { /* no-op */ }
    try { fs.closeSync(errFd); } catch (_) { /* no-op */ }
  }
  if (typeof child.unref === 'function') child.unref();
  fs.writeFileSync(paths.pidPath, `${child.pid}\n`, 'utf8');

  const listener = await waitForListenerImpl({
    host,
    port,
    timeoutMs: parsePositiveInteger(options.timeoutMs, 60000),
    intervalMs: parsePositiveInteger(options.intervalMs, 500),
  });
  if (!listener.ok) {
    const processRunningBeforeStop = child?.pid ? isProcessRunning(child.pid) : false;
    const stopResult = stopConsoleRuntime({
      cwd,
      port,
      logger,
      spawnSyncImpl: options.spawnSyncImpl || spawnSync,
      platform: options.platform,
    });
    const runtime = buildConsoleRuntimeFailure({
      cwd,
      host,
      port,
      command,
      child,
      paths,
      listener,
      env,
      stopResult,
      processRunningBeforeStop,
      logTailLimit: options.logTailLimit,
    });
    const error = new Error(`console_listener_timeout:${host}:${port}`);
    error.runtime = runtime;
    throw error;
  }
  logger.log(`[workspace/local-console] Started Console V2 pid=${child.pid} url=http://${host}:${port}`);
  return { ok: true, reused: false, pid: child.pid, listener, paths };
}

function stopConsoleRuntime(options = {}) {
  const cwd = options.cwd || process.cwd();
  const port = parsePositiveInteger(options.port, 5175);
  const logger = options.logger || console;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const paths = getConsoleRuntimePaths(cwd, port);
  const pid = readPid(paths.pidPath);
  let killed = false;
  if (pid && isProcessRunning(pid)) {
    if ((options.platform || process.platform) === 'win32') {
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
  const orphanCleanup = stopOrphanedConsoleRuntime({
    cwd,
    port,
    logger,
    spawnSyncImpl,
    platform: options.platform,
  });
  logger.log(`[workspace/local-console] Stopped Console V2 port=${port} pid=${pid || 0} killed=${killed}`);
  return { ok: true, running: Boolean(pid), pid, killed, orphan_cleanup: orphanCleanup };
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
  const port = parsePositiveInteger(args.port || process.env.CONSOLE_PORT, 5175);
  if (args.command === 'stop') {
    console.log(JSON.stringify(stopConsoleRuntime({ port }), null, 2));
    return;
  }
  const result = await startConsoleRuntime({
    port,
    host: args.host || '127.0.0.1',
    timeoutMs: parsePositiveInteger(args['timeout-ms'], 60000),
    intervalMs: parsePositiveInteger(args['interval-ms'], 500),
  });
  console.log(JSON.stringify({
    ok: result.ok,
    reused: result.reused,
    pid: result.pid,
    listener: result.listener,
    url: `http://${args.host || '127.0.0.1'}:${port}`,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`local-console-runtime: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  buildConsoleDevCommand,
  buildConsoleRuntimeFailure,
  getConsoleRuntimePaths,
  readPid,
  readConsoleLogTail,
  redactConsoleRuntimeText,
  resolveConsoleEnv,
  startConsoleRuntime,
  stopConsoleRuntime,
  stopOrphanedConsoleRuntime,
  waitForConsoleListener,
};
