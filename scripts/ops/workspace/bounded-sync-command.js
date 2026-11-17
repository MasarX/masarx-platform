const { spawnSync } = require('child_process');

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_DISCOVERY_MAX_BUFFER_BYTES = 1024 * 1024;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runBoundedSyncCommand(command, args = [], options = {}) {
  const timeoutMs = parsePositiveInteger(
    options.timeoutMs ?? options.env?.MASARX_DISCOVERY_COMMAND_TIMEOUT_MS,
    DEFAULT_DISCOVERY_TIMEOUT_MS,
  );
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const startedAt = Date.now();
  let result;

  try {
    result = spawnSyncImpl(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: parsePositiveInteger(options.maxBuffer, DEFAULT_DISCOVERY_MAX_BUFFER_BYTES),
    });
  } catch (error) {
    result = { error, status: null, signal: null, stdout: '', stderr: '' };
  }

  const stdout = String(result?.stdout || '');
  const stderr = String(result?.stderr || '');
  const errorCode = String(result?.error?.code || '');
  const timedOut = errorCode === 'ETIMEDOUT';
  const ok = result?.status === 0 && !result?.error;

  return {
    ok,
    timed_out: timedOut,
    failure_kind: ok ? '' : (timedOut ? 'timeout' : (result?.error ? 'spawn_error' : 'nonzero_exit')),
    status: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal || null,
    stdout,
    stderr,
    error: result?.error || null,
    timeout_ms: timeoutMs,
    duration_ms: Math.max(0, Date.now() - startedAt),
  };
}

function assertCommandDidNotTimeOut(result, probeName) {
  if (!result?.timed_out) return result;
  const timeoutMs = parsePositiveInteger(result.timeout_ms, DEFAULT_DISCOVERY_TIMEOUT_MS);
  const error = new Error(`${String(probeName || 'workspace discovery probe')} timed out after ${timeoutMs}ms`);
  error.code = 'MASARX_DISCOVERY_TIMEOUT';
  error.probe = String(probeName || 'workspace discovery probe');
  error.timeout_ms = timeoutMs;
  error.partial_stdout = String(result.stdout || '');
  error.partial_stderr = String(result.stderr || '');
  throw error;
}

module.exports = {
  DEFAULT_DISCOVERY_MAX_BUFFER_BYTES,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  assertCommandDidNotTimeOut,
  parsePositiveInteger,
  runBoundedSyncCommand,
};
