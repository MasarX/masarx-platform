const fs = require('fs');
const dns = require('dns');
const os = require('os');
const path = require('path');

describe('load-env precedence and overrides', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const originalDnsOrder = dns.getDefaultResultOrder();
  const tempRepos = new Set();
  const explicitLogCacheKey = Symbol.for('masarx.load-env.explicit-log-cache');
  const cacheKeys = [explicitLogCacheKey, Symbol.for('masarx.load-env.dotenv-fallback-logged')];
  const originalCacheDescriptors = cacheKeys.map((key) => [key, Object.getOwnPropertyDescriptor(global, key)]);
  const mockMissingDotenv = () => {
    jest.resetModules();
    const resolveDotenv = jest.fn(() => {
      const error = new Error("Cannot find module 'dotenv'");
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    });
    jest.doMock('dotenv', resolveDotenv);
    return resolveDotenv;
  };
  const resetLoadEnvControls = () => {
    delete process.env.ENV_FILE;
    delete process.env.ENV_FILE_OVERRIDE;
    delete process.env.ENV_FILE_APPEND;
    delete process.env.LOAD_ENV_VERBOSE;
  };

  function restoreBaseEnv() {
    process.env = { ...originalEnv };
    resetLoadEnvControls();
  }

  const load = () => {
    // Defer require so we pick up fresh process.env each time
    delete require.cache[require.resolve('../../scripts/utils/load-env')];
    const { loadEnv } = require('../../scripts/utils/load-env');
    loadEnv();
  };

  const useDefaultPrecedence = () => {
    delete process.env.ENV_FILE_OVERRIDE;
    delete process.env.ENV_FILE_APPEND;
  };

  function makeTempRepo(supabaseUrl = 'https://temp.supabase.co') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-env-'));
    tempRepos.add(dir);
    const envDir = path.join(dir, 'config', 'env');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, '.env.cloud'), `SUPABASE_URL=${supabaseUrl}\n`, 'utf8');
    return dir;
  }

  beforeEach(() => {
    restoreBaseEnv();
    process.chdir(originalCwd);
    for (const key of cacheKeys) delete global[key];
    jest.resetModules();
    jest.dontMock('dotenv');
  });

  afterEach(() => {
    try {
      process.env = { ...originalEnv };
      process.chdir(originalCwd);
      for (const [key, descriptor] of originalCacheDescriptors) {
        if (descriptor) Object.defineProperty(global, key, descriptor);
        else delete global[key];
      }
      dns.setDefaultResultOrder(originalDnsOrder);
      jest.restoreAllMocks();
      jest.dontMock('dotenv');
      jest.resetModules();
    } finally {
      for (const dir of tempRepos) {
        const resolved = path.resolve(dir);
        if (
          path.dirname(resolved) !== path.resolve(os.tmpdir())
          || !path.basename(resolved).startsWith('load-env-')
        ) throw new Error('load-env test cleanup escaped its exact mkdtemp root');
        fs.rmSync(resolved, { recursive: true, force: true });
      }
      tempRepos.clear();
    }
  });

  test('default resolution loads .env.cloud without overriding existing values', () => {
    const repo = makeTempRepo('https://temp.supabase.co');
    process.chdir(repo);
    useDefaultPrecedence();
    delete process.env.ENV_FILE;
    process.env.SUPABASE_URL = 'https://example.invalid';

    load();

    expect(process.env.SUPABASE_URL).toBe('https://example.invalid');
  });

  test('explicit ENV_FILE does not override existing values (process.env wins)', () => {
    const repo = makeTempRepo('https://explicit.supabase.co');
    const envFile = path.join(repo, 'config', 'env', '.env.cloud');
    process.chdir(repo);
    useDefaultPrecedence();
    process.env.SUPABASE_URL = 'https://example.invalid';
    process.env.ENV_FILE = envFile;
    // Keep baseline behavior deterministic when CI sets ENV_FILE_OVERRIDE globally.
    delete process.env.ENV_FILE_OVERRIDE;

    load();

    expect(process.env.SUPABASE_URL).toBe('https://example.invalid');
  });

  test('ENV_FILE_OVERRIDE=1 makes explicit ENV_FILE authoritative', () => {
    const repo = makeTempRepo('https://override.supabase.co');
    const envFile = path.join(repo, 'config', 'env', '.env.cloud');
    process.chdir(repo);
    process.env.SUPABASE_URL = 'https://example.invalid';
    process.env.ENV_FILE = envFile;
    process.env.ENV_FILE_OVERRIDE = '1';

    load();

    expect(process.env.SUPABASE_URL).toBe('https://override.supabase.co');
  });

  test('authoritative local env replaces an inherited empty DB URL while leaving direct hints to policy', () => {
    const repo = makeTempRepo();
    const envFile = path.join(repo, 'config', 'env', '.env.local');
    fs.writeFileSync(
      envFile,
      ('DATABASE_URL=' + ['postgresql',":","/","/",'postgres',":",'postgres',"@",'127.0.0.1',":",'23197',"/",'postgres\n'].join("")),
      'utf8',
    );
    process.chdir(repo);
    process.env.DATABASE_URL = '';
    process.env.DATABASE_URL_DIRECT = (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join(""));
    process.env.ENV_FILE = envFile;
    process.env.ENV_FILE_OVERRIDE = '1';
    process.env.ENV_FILE_APPEND = '0';

    load();

    expect(process.env.DATABASE_URL).toBe(
      (['postgresql',":","/","/",'postgres',":",'postgres',"@",'127.0.0.1',":",'23197',"/",'postgres'].join("")),
    );
    expect(process.env.DATABASE_URL_DIRECT).toContain('db.abcdefghijklmnopqrst.supabase.co');
  });

  test('default resolution loads .env.cloud when variable is unset', () => {
    const repo = makeTempRepo('https://fallback.supabase.co');
    process.chdir(repo);
    useDefaultPrecedence();
    delete process.env.ENV_FILE;
    delete process.env.SUPABASE_URL;

    load();

    expect(process.env.SUPABASE_URL).toBe('https://fallback.supabase.co');
  });

  test('missing explicit ENV_FILE falls back to default candidates', () => {
    const repo = makeTempRepo('https://fallback-from-missing-explicit.supabase.co');
    process.chdir(repo);
    useDefaultPrecedence();
    process.env.ENV_FILE = path.join(repo, 'config', 'env', 'does-not-exist.env');
    delete process.env.SUPABASE_URL;

    load();

    expect(process.env.SUPABASE_URL).toBe('https://fallback-from-missing-explicit.supabase.co');
  });

  test('ENV_FILE_APPEND=1 merges explicit file with default candidates', () => {
    const repo = makeTempRepo('https://append-mode-fallback.supabase.co');
    const explicitPath = path.join(repo, 'config', 'env', '.env.explicit');
    fs.writeFileSync(explicitPath, 'EDGE_REQUIRE_DB_JWT=0\n', 'utf8');

    process.chdir(repo);
    process.env.ENV_FILE = explicitPath;
    process.env.ENV_FILE_APPEND = '1';
    delete process.env.SUPABASE_URL;
    delete process.env.EDGE_REQUIRE_DB_JWT;

    load();

    expect(process.env.EDGE_REQUIRE_DB_JWT).toBe('0');
    expect(process.env.SUPABASE_URL).toBe('https://append-mode-fallback.supabase.co');
  });

  test('explicit ENV_FILE message logs once per process by default', () => {
    const repo = makeTempRepo('https://single-log.supabase.co');
    const envFile = path.join(repo, 'config', 'env', '.env.cloud');
    process.chdir(repo);
    useDefaultPrecedence();
    process.env.ENV_FILE = envFile;
    delete process.env.SUPABASE_URL;

    const logSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    load();
    delete process.env.SUPABASE_URL;
    load();

    const explicitLogs = logSpy.mock.calls
      .map((args) => String(args[0] || ''))
      .filter((line) => line.includes('[load-env] Using explicit ENV_FILE='));

    expect(explicitLogs.length).toBe(1);
    logSpy.mockRestore();
  });

  test('skips dotenv resolution with no env files and preserves injected values', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'load-env-empty-'));
    tempRepos.add(repo);
    process.chdir(repo);
    process.env.SUPABASE_URL = 'https://injected.supabase.co';
    process.env.LOAD_ENV_INJECTED_EMPTY = '';
    const injectedEnv = { ...process.env };
    const resolveDotenv = mockMissingDotenv();

    jest.isolateModules(() => {
      const { loadEnv } = require('../../scripts/utils/load-env');
      expect(() => {
        loadEnv();
        loadEnv();
      }).not.toThrow();
    });

    expect(resolveDotenv).not.toHaveBeenCalled();
    expect(process.env).toEqual(injectedEnv);
    expect(fs.readdirSync(repo)).toEqual([]);
  });

  test('uses a cloud example only in tests and preserves a configured URL', () => {
    const repo = makeTempRepo();
    const cloudFile = path.join(repo, 'config', 'env', '.env.cloud');
    fs.renameSync(cloudFile, `${cloudFile}.example`);
    fs.writeFileSync(`${cloudFile}.example`, 'SUPABASE_URL=<your-project-ref>\n', 'utf8');
    process.chdir(repo);
    delete process.env.SUPABASE_URL;

    process.env.NODE_ENV = 'production';
    load();
    expect(process.env.SUPABASE_URL).toBeUndefined();

    process.env.NODE_ENV = 'test';
    process.env.ENV_FILE = cloudFile;
    process.env.ENV_FILE_OVERRIDE = '1';
    load();
    expect(process.env.SUPABASE_URL).toBe('https://example.invalid');

    process.env.SUPABASE_URL = 'https://injected.example.invalid';
    load();
    expect(process.env.SUPABASE_URL).toBe('https://injected.example.invalid');

    process.env.SUPABASE_URL = '';
    load();
    expect(process.env.SUPABASE_URL).toBe('');
  });

  test('falls back to the Node stdlib parser when dotenv is unavailable', () => {
    const repo = makeTempRepo('https://stdlib-fallback.supabase.co');
    process.chdir(repo);
    useDefaultPrecedence();
    delete process.env.ENV_FILE;
    delete process.env.SUPABASE_URL;

    const resolveDotenv = mockMissingDotenv();
    jest.isolateModules(() => {
      const { loadEnv } = require('../../scripts/utils/load-env');
      loadEnv();
    });

    expect(resolveDotenv).toHaveBeenCalledTimes(1);
    expect(process.env.SUPABASE_URL).toBe('https://stdlib-fallback.supabase.co');
  });
});
