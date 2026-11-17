const { EventEmitter } = require('events');

function createMissingPgError() {
  const error = new Error("Cannot find module 'pg'");
  error.code = 'MODULE_NOT_FOUND';
  return error;
}

describe('preview-project DB connectivity probe', () => {
  test('returns ok:false and does not crash when pg emits an error event', async () => {
    jest.resetModules();
    jest.doMock('pg', () => {
      class Client extends EventEmitter {
        async connect() {}
        async query() {
          const err = new Error('terminating connection due to administrator command');
          err.code = '57P01';
          this.emit('error', err);
          return { rows: [{ '?column?': 1 }] };
        }
        async end() {}
      }
      return { Client };
    });

    const { checkDbConnectivity } = require('../../../scripts/ops/workspace/preview-project');
    const res = await checkDbConnectivity({
      connectionString: 'postgresql://example',
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: 1,
    });

    expect(res.ok).toBe(false);
    expect(String(res.error?.message || '')).toMatch(/terminating connection/i);
  });

  test('returns ok:true when connect/query/end succeed', async () => {
    jest.resetModules();
    jest.doMock('pg', () => {
      class Client extends EventEmitter {
        async connect() {}
        async query() {
          return { rows: [{ '?column?': 1 }] };
        }
        async end() {}
      }
      return { Client };
    });

    const { checkDbConnectivity } = require('../../../scripts/ops/workspace/preview-project');
    const res = await checkDbConnectivity({
      connectionString: 'postgresql://example',
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: 1,
    });

    expect(res).toEqual({ ok: true });
  });

  test('falls back to psql when pg is unavailable during preview bootstrap', async () => {
    jest.resetModules();
    jest.doMock('pg', () => {
      throw createMissingPgError();
    });

    const spawnSyncImpl = jest.fn(() => ({
      status: 0,
      stdout: '1\n',
      stderr: '',
    }));

    const { checkDbConnectivity } = require('../../../scripts/ops/workspace/preview-project');
    const res = await checkDbConnectivity({
      connectionString: 'postgresql://example',
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: 1500,
      spawnSyncImpl,
    });

    expect(res).toEqual({ ok: true });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'psql',
      ['-d', 'postgresql://example', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', 'select 1'],
      expect.objectContaining({
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2500,
      }),
    );
  });

  test('returns a bootstrap-client error when neither pg nor psql is available', async () => {
    jest.resetModules();
    jest.doMock('pg', () => {
      throw createMissingPgError();
    });

    const spawnSyncImpl = jest.fn(() => ({
      error: Object.assign(new Error('spawnSync psql ENOENT'), { code: 'ENOENT' }),
      status: null,
      stdout: '',
      stderr: '',
    }));

    const { checkDbConnectivity } = require('../../../scripts/ops/workspace/preview-project');
    const res = await checkDbConnectivity({
      connectionString: 'postgresql://example',
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: 1500,
      spawnSyncImpl,
    });

    expect(res.ok).toBe(false);
    expect(String(res.error?.message || '')).toMatch(/pg|psql/i);
  });

  test('handles multiple pg error events without uncaught crash', async () => {
    jest.resetModules();
    jest.doMock('pg', () => {
      class Client extends EventEmitter {
        async connect() {}
        async query() {
          const err = new Error('password authentication failed');
          err.code = '28P01';
          this.emit('error', err);
          return { rows: [{ '?column?': 1 }] };
        }
        async end() {
          const err = new Error('terminating connection due to administrator command');
          err.code = '57P01';
          this.emit('error', err);
        }
      }
      return { Client };
    });

    const { checkDbConnectivity } = require('../../../scripts/ops/workspace/preview-project');
    const res = await checkDbConnectivity({
      connectionString: 'postgresql://example',
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: 1,
    });

    expect(res.ok).toBe(false);
    expect(String(res.error?.message || '')).toMatch(/password authentication failed/i);
  });

  test('fails closed when pg connect hangs past the bounded operation timeout', async () => {
    jest.resetModules();
    jest.doMock('pg', () => {
      class Client extends EventEmitter {
        async connect() {
          return await new Promise(() => {});
        }
        async query() {
          return { rows: [{ '?column?': 1 }] };
        }
        async end() {}
      }
      return { Client };
    });

    const { checkDbConnectivity } = require('../../../scripts/ops/workspace/preview-project');
    const res = await checkDbConnectivity({
      connectionString: 'postgresql://example',
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: 25,
    });

    expect(res.ok).toBe(false);
    expect(String(res.error?.message || '')).toMatch(/DB client connect timed out/i);
  });

  test('preserves the original auth failure when pg end hangs during cleanup', async () => {
    jest.resetModules();
    jest.doMock('pg', () => {
      class Client extends EventEmitter {
        async connect() {}
        async query() {
          const err = new Error('Tenant or user not found');
          err.code = '28P01';
          throw err;
        }
        async end() {
          return await new Promise(() => {});
        }
      }
      return { Client };
    });

    const { checkDbConnectivity } = require('../../../scripts/ops/workspace/preview-project');
    const res = await checkDbConnectivity({
      connectionString: 'postgresql://example',
      attempts: 1,
      intervalMs: 0,
      connectionTimeoutMillis: 25,
    });

    expect(res.ok).toBe(false);
    expect(String(res.error?.message || '')).toMatch(/Tenant or user not found/i);
  });

  test('refreshProjectDbPassword forwards bounded retry settings to the shared Supabase API helper', async () => {
    jest.resetModules();
    const setProjectDatabasePassword = jest.fn().mockResolvedValue({ ok: true });
    jest.doMock('../../../scripts/ops/workspace/supabase-api', () => ({
      setProjectDatabasePassword,
    }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { refreshProjectDbPassword } = require('../../../scripts/ops/workspace/preview-project');

    await expect(
      refreshProjectDbPassword({
        projectRef: 'proj-ref',
        token: 'token',
        dbPass: 'secret-pass',
        maxWaitMs: 120000,
        retryDelayMs: 5000,
        label: 'recreated preview project',
      }),
    ).resolves.toBe(true);

    expect(setProjectDatabasePassword).toHaveBeenCalledWith({
      projectRef: 'proj-ref',
      token: 'token',
      password: 'secret-pass',
      maxWaitMs: 120000,
      retryDelayMs: 5000,
    });

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
