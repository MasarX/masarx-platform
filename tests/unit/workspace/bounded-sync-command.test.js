const {
  DEFAULT_DISCOVERY_MAX_BUFFER_BYTES,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  assertCommandDidNotTimeOut,
  runBoundedSyncCommand,
} = require('../../../scripts/ops/workspace/bounded-sync-command');

describe('bounded synchronous workspace commands', () => {
  test('enforces a shell-free hidden process with bounded output and runtime', () => {
    const spawnSyncImpl = jest.fn(() => ({ status: 0, stdout: 'ready\n', stderr: '' }));

    const result = runBoundedSyncCommand('docker', ['ps'], {
      cwd: '/example/workspace',
      env: { MASARX_DISCOVERY_COMMAND_TIMEOUT_MS: '3210' },
      spawnSyncImpl,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      timed_out: false,
      failure_kind: '',
      status: 0,
      stdout: 'ready\n',
      timeout_ms: 3210,
    }));
    expect(spawnSyncImpl).toHaveBeenCalledWith('docker', ['ps'], expect.objectContaining({
      cwd: '/example/workspace',
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
      timeout: 3210,
      killSignal: 'SIGKILL',
      maxBuffer: DEFAULT_DISCOVERY_MAX_BUFFER_BYTES,
    }));
  });

  test('uses the canonical timeout when an override is absent or invalid', () => {
    const spawnSyncImpl = jest.fn(() => ({ status: 1, stdout: '', stderr: 'no daemon' }));
    const result = runBoundedSyncCommand('docker', ['ps'], {
      env: { MASARX_DISCOVERY_COMMAND_TIMEOUT_MS: '0' },
      spawnSyncImpl,
    });

    expect(result.timeout_ms).toBe(DEFAULT_DISCOVERY_TIMEOUT_MS);
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      timed_out: false,
      failure_kind: 'nonzero_exit',
      status: 1,
      stderr: 'no daemon',
    }));
  });

  test('classifies a timeout truthfully and retains bounded partial output', () => {
    const error = Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const result = runBoundedSyncCommand('docker', ['ps'], {
      timeoutMs: 125,
      spawnSyncImpl: () => ({
        status: null,
        signal: 'SIGKILL',
        stdout: 'partial docker output\n',
        stderr: 'partial diagnostic\n',
        error,
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      timed_out: true,
      failure_kind: 'timeout',
      status: null,
      signal: 'SIGKILL',
      stdout: 'partial docker output\n',
      stderr: 'partial diagnostic\n',
      timeout_ms: 125,
      error,
    }));
    expect(() => assertCommandDidNotTimeOut(result, 'Docker inventory probe')).toThrow(
      /Docker inventory probe timed out after 125ms/,
    );
    try {
      assertCommandDidNotTimeOut(result, 'Docker inventory probe');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({
        code: 'MASARX_DISCOVERY_TIMEOUT',
        timeout_ms: 125,
        partial_stdout: 'partial docker output\n',
        partial_stderr: 'partial diagnostic\n',
      }));
    }
  });

  test('kills a genuinely hung direct probe before returning', () => {
    const startedAt = Date.now();
    const result = runBoundedSyncCommand(process.execPath, [
      '-e',
      'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);',
    ], { timeoutMs: 250 });
    const childPid = Number.parseInt(result.stdout, 10);

    expect(result.timed_out).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});
