'use strict';

// Existing-server inspection only. Never invoke the native adb client: even
// "adb devices" can start or replace its server. Protocol: AOSP SERVICES.TXT.
const net = require('net');
const { spawnSync } = require('child_process');
const MAX_BYTES = 65535;
const DEFAULT_TIMEOUT_MS = 2000;
const BOOT_PROPERTIES = ['sys.boot_completed', 'dev.bootcomplete', 'init.svc.bootanim', 'sys.bootstat.first_boot_completed'];
const PROPERTIES = ['ro.boot.qemu.avd_name', 'ro.kernel.qemu.avd_name'];

class AdbInspectionError extends Error {
  constructor(reason) {
    super('ADB existing-server inspection unavailable: ' + reason);
    this.code = 'ADB_INSPECTION_UNKNOWN';
    this.reason = reason;
  }
}
function fail(reason) { throw new AdbInspectionError(reason); }
function validateSerial(serial) {
  if (typeof serial !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(serial)) fail('invalid_serial');
  return serial;
}
function endpointFromEnv(env = {}) {
  const socket = env.ADB_SERVER_SOCKET;
  // objectives:allow LOCALHOST Justification: ADB inspection defaults to loopback only.
  let host = env.ANDROID_ADB_SERVER_ADDRESS || '127.0.0.1';
  let port = env.ANDROID_ADB_SERVER_PORT || '5037';
  if (socket) {
    const match = /^tcp:(?:(127\.0\.0\.1|localhost|\[::1\]):)?([0-9]{1,5})$/.exec(socket);
    if (!match) fail('invalid_endpoint');
    // objectives:allow LOCALHOST Justification: accepts only loopback ADB socket forms.
    host = match[1] || '127.0.0.1';
    port = match[2];
  }
  // objectives:allow LOCALHOST Justification: normalizes a validated loopback ADB host.
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) || !/^[0-9]{1,5}$/.test(String(port))) fail('invalid_endpoint');
  port = Number(port);
  if (port < 1 || port > 65535) fail('invalid_endpoint');
  // objectives:allow LOCALHOST Justification: returns only validated loopback ADB hosts.
  return { host: host === 'localhost' ? '127.0.0.1' : host.replace(/^\[|\]$/g, ''), port };
}
function validateRequest(request = {}) {
  if (!['devices', 'reverse', 'avd-name', 'boot-properties'].includes(request.kind)) fail('request_not_allowed');
  if (request.kind !== 'devices') validateSerial(request.serial);
  if (request.kind === 'avd-name' && !PROPERTIES.includes(request.property)) fail('property_not_allowed');
  return request;
}
function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { return fail('invalid_utf8'); }
}
async function queryExistingServer(request, options = {}) {
  let socket;
  let timer;
  try {
    validateRequest(request);
    const endpoint = endpointFromEnv(options.env || process.env);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('invalid_deadline');
    let buffer = Buffer.alloc(0), ended = false, failure = null, waiting = null, received = 0;
    const pump = () => {
      if (!waiting) return;
      if (failure) { const waiter = waiting; waiting = null; waiter.reject(failure); return; }
      if (waiting.size === null ? ended : buffer.length >= waiting.size) {
        const waiter = waiting; waiting = null;
        const size = waiter.size === null ? buffer.length : waiter.size;
        const value = buffer.subarray(0, size); buffer = buffer.subarray(size);
        waiter.resolve(value);
      } else if (ended) { const waiter = waiting; waiting = null; waiter.reject(new AdbInspectionError('truncated_response')); }
    };
    const read = size => new Promise((resolve, reject) => { waiting = { size, resolve, reject }; pump(); });
    socket = net.createConnection(endpoint);
    socket.on('data', bytes => {
      received += bytes.length;
      if (received > MAX_BYTES + 32) failure = new AdbInspectionError('oversized_response');
      else buffer = Buffer.concat([buffer, bytes]);
      pump();
    });
    socket.on('end', () => { ended = true; pump(); });
    socket.on('error', () => { failure = new AdbInspectionError('server_unreachable'); pump(); });
    socket.on('close', () => { ended = true; pump(); });
    timer = setTimeout(() => { failure = new AdbInspectionError('deadline'); pump(); socket.destroy(); }, timeoutMs);
    const lengthPayload = async () => {
      const header = (await read(4)).toString('latin1');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) fail('invalid_length');
      const length = Number.parseInt(header, 16);
      if (length > MAX_BYTES) fail('oversized_response');
      return read(length);
    };
    const send = async command => {
      const data = Buffer.from(command);
      socket.write(Buffer.from(data.length.toString(16).padStart(4, '0') + command));
      const status = (await read(4)).toString('latin1');
      if (status === 'FAIL') { await lengthPayload(); fail('server_rejected'); }
      if (status !== 'OKAY') fail('invalid_status');
    };
    if (request.kind !== 'devices') await send('host:transport:' + request.serial);
    const shellRequest = request.kind === 'avd-name' || request.kind === 'boot-properties';
    const command = request.kind === 'devices' ? 'host:devices-l'
      : request.kind === 'reverse' ? 'reverse:list-forward'
      : request.kind === 'boot-properties' ? 'shell:' + BOOT_PROPERTIES.map(property => 'getprop ' + property).join('; ')
        : 'shell:getprop ' + request.property;
    await send(command);
    const bytes = shellRequest ? await read(null) : await lengthPayload();
    if (!shellRequest && (await read(null)).length) fail('trailing_response');
    if (buffer.length) fail('trailing_response');
    return { available: true, value: decode(bytes) };
  } catch (error) {
    return { available: false, reason: error instanceof AdbInspectionError ? error.reason : 'inspection_failed' };
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}

// Minimal sync bridge for existing synchronous callers. Credentials, NODE_OPTIONS,
// NODE_PATH and dynamic-loader injection are excluded, not copied then filtered.
function bridgeEnv(env = {}) {
  return Object.fromEntries(['SystemRoot', 'WINDIR'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}
function inspectAdbSync(request, options = {}) {
  try {
    validateRequest(request);
    const endpoint = endpointFromEnv(options.env || process.env);
    let timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('invalid_deadline');
    const remainingBudget = () => {
      if (options.signal?.aborted) fail('aborted');
      if (options.deadlineAtMs === undefined) return null;
      const nowMs = typeof options.nowFn === 'function' ? options.nowFn() : Date.now();
      if (!Number.isFinite(options.deadlineAtMs) || !Number.isFinite(nowMs)) fail('invalid_deadline');
      const remainingMs = Math.floor(options.deadlineAtMs - nowMs);
      if (remainingMs < 1) fail('deadline');
      return remainingMs;
    };
    const remainingMs = remainingBudget();
    if (remainingMs !== null) {
      // Keep the existing one-second child settlement allowance inside the caller deadline.
      if (remainingMs <= 1000) fail('deadline');
      timeoutMs = Math.min(timeoutMs, remainingMs - 1000);
    }
    const runner = options.spawnSyncImpl || spawnSync;
    const result = runner(process.execPath, [__filename, '--read-only-query'], {
      input: JSON.stringify({ request, endpoint, timeoutMs }),
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 1000,
      maxBuffer: MAX_BYTES * 8, env: bridgeEnv(options.env || process.env),
    });
    if (result.error || result.status !== 0) fail('bridge_failed');
    const parsed = JSON.parse(result.stdout);
    remainingBudget();
    if (parsed.available === true && typeof parsed.value === 'string') return parsed;
    if (parsed.available === false && typeof parsed.reason === 'string' && /^[a-z_]+$/.test(parsed.reason)) return parsed;
    fail('invalid_bridge_response');
  } catch (error) {
    return { available: false, reason: error instanceof AdbInspectionError ? error.reason : 'invalid_bridge_response' };
  }
}
function requireInspection(result) {
  if (result?.available !== true) fail(result?.reason || 'unknown');
  return result.value;
}
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--read-only-query') process.exit(2);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { input += data; if (input.length > 2048) process.exit(2); });
  process.stdin.on('end', async () => {
    try {
      const { request, endpoint, timeoutMs } = JSON.parse(input);
      const env = { ANDROID_ADB_SERVER_ADDRESS: endpoint.host, ANDROID_ADB_SERVER_PORT: String(endpoint.port) };
      process.stdout.write(JSON.stringify(await queryExistingServer(request, { env, timeoutMs })));
    } catch (_) { process.stdout.write(JSON.stringify({ available: false, reason: 'invalid_bridge_input' })); }
  });
}
module.exports = { BOOT_PROPERTIES, DEFAULT_TIMEOUT_MS, AdbInspectionError, endpointFromEnv, validateSerial, queryExistingServer, inspectAdbSync, requireInspection, bridgeEnv };
