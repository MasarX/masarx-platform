const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanSecretText } = require('../../../scripts/ops/workspace/docker-runtime/redaction');

describe('migrate-local canonical history contract', () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let cwd;

  function loadMigrations() {
    jest.isolateModules(() => {
      require('../../../scripts/ops/migrate-local');
    });
  }

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-migrate-local-'));
    fs.mkdirSync(path.join(cwd, 'supabase', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'supabase', 'migrations', '202601010000_example.sql'),
      'select 1;',
      'utf8',
    );
    process.chdir(cwd);
    process.env.DATABASE_URL = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'127.0.0.1',":",'5432',"/",'postgres'].join(""));
    jest.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    jest.restoreAllMocks();
    jest.resetModules();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('missing canonical history fails before replaying any migration SQL', async () => {
    const missingHistory = new Error('relation "supabase_migrations.schema_migrations" does not exist');
    missingHistory.code = '42P01';
    const query = jest.fn().mockRejectedValueOnce(missingHistory);
    const connect = jest.fn().mockResolvedValue(undefined);
    const end = jest.fn().mockResolvedValue(undefined);
    const Client = jest.fn(() => ({ connect, end, query }));
    jest.doMock('pg', () => ({ Client }));
    jest.doMock('../../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    loadMigrations();
    await new Promise((resolve) => setImmediate(resolve));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'select version from supabase_migrations.schema_migrations order by version',
    );
    expect(end).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('schema_migrations'));
    expect(warn).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('records a successfully applied migration in canonical history before reporting success', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const connect = jest.fn().mockResolvedValue(undefined);
    const end = jest.fn().mockResolvedValue(undefined);
    const Client = jest.fn(() => ({ connect, end, query }));
    jest.doMock('pg', () => ({ Client }));
    jest.doMock('../../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    loadMigrations();
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenNthCalledWith(
      1,
      'select version from supabase_migrations.schema_migrations order by version',
    );
    expect(query).toHaveBeenNthCalledWith(2, 'select 1;');
    expect(query.mock.calls[2][0]).toContain(
      'INSERT INTO supabase_migrations.schema_migrations',
    );
    expect(query.mock.calls[2][1]).toEqual(['202601010000', ['select 1;'], 'example']);
    expect(log).toHaveBeenCalledWith('[migrate-local] Using configured database connection.');
    expect(log).toHaveBeenCalledWith('[migrate-local] All migrations applied successfully.');
    expect(log.mock.calls.flat().join('\n')).not.toContain(process.env.DATABASE_URL);
    expect(scanSecretText(log.mock.calls.flat().join('\n'))).toEqual([]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  test.each([false, true])('an allowlisted failure must rollback before continuing (rollback fails: %s)', async (rollbackFails) => {
    fs.writeFileSync(
      path.join(cwd, 'supabase', 'migrations', '202510110001_extensions.sql'),
      'BEGIN; select fails;',
      'utf8',
    );
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('synthetic migration failure'))
      .mockImplementationOnce(async () => {
        if (rollbackFails) throw new Error('synthetic rollback failure');
        return { rows: [] };
      })
      .mockResolvedValue({ rows: [] });
    const connect = jest.fn().mockResolvedValue(undefined);
    const end = jest.fn().mockResolvedValue(undefined);
    jest.doMock('pg', () => ({ Client: jest.fn(() => ({ connect, end, query })) }));
    jest.doMock('../../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    loadMigrations();
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenNthCalledWith(2, 'BEGIN; select fails;');
    expect(query).toHaveBeenNthCalledWith(3, 'ROLLBACK');
    const historyWrites = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO supabase_migrations.schema_migrations'));
    if (rollbackFails) {
      expect(query).toHaveBeenCalledTimes(3);
      expect(historyWrites).toEqual([]);
      expect(error).toHaveBeenCalledWith('[migrate-local] Failed: synthetic rollback failure');
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalledWith('[migrate-local] All migrations applied successfully.');
      expect(exit).toHaveBeenCalledWith(1);
    } else {
      expect(query).toHaveBeenNthCalledWith(4, 'select 1;');
      expect(historyWrites).toHaveLength(1);
      expect(historyWrites[0][1]).toEqual(['202601010000', ['select 1;'], 'example']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('soft-fail allowed'));
      expect(log).toHaveBeenCalledWith('[migrate-local] All migrations applied successfully.');
      expect(error).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    }
    expect(end).toHaveBeenCalledTimes(1);
  });

  test('a late canonical history insert failure remains terminal for a soft-fail migration', async () => {
    fs.rmSync(path.join(cwd, 'supabase', 'migrations', '202601010000_example.sql'));
    fs.writeFileSync(
      path.join(cwd, 'supabase', 'migrations', '202510110001_extensions.sql'),
      'select 1;',
      'utf8',
    );
    const historyInsertError = new Error('history insert failed');
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(historyInsertError);
    const connect = jest.fn().mockResolvedValue(undefined);
    const end = jest.fn().mockResolvedValue(undefined);
    const Client = jest.fn(() => ({ connect, end, query }));
    jest.doMock('pg', () => ({ Client }));
    jest.doMock('../../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    loadMigrations();
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith('[migrate-local] Failed: history insert failed');
    expect(log).not.toHaveBeenCalledWith('[migrate-local] All migrations applied successfully.');
    expect(warn).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
