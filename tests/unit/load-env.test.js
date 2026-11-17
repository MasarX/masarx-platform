const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

describe('load-env precedence and overrides', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const explicitLogCacheKey = Symbol.for('masarx.load-env.explicit-log-cache');
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
    const envDir = path.join(dir, 'config', 'env');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, '.env.cloud'), `SUPABASE_URL=${supabaseUrl}\n`, 'utf8');
    return dir;
  }

  beforeEach(() => {
    restoreBaseEnv();
    process.chdir(originalCwd);
    delete global[explicitLogCacheKey];
  });

  afterEach(() => {
    restoreBaseEnv();
    process.chdir(originalCwd);
    delete global[explicitLogCacheKey];
    jest.restoreAllMocks();
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

  test('falls back to the Node stdlib parser when dotenv is unavailable', () => {
    const repo = makeTempRepo('https://stdlib-fallback.supabase.co');
    process.chdir(repo);
    useDefaultPrecedence();
    delete process.env.ENV_FILE;
    delete process.env.SUPABASE_URL;

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'dotenv') {
        const error = new Error("Cannot find module 'dotenv'");
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      load();
    } finally {
      Module._load = originalLoad;
    }

    expect(process.env.SUPABASE_URL).toBe('https://stdlib-fallback.supabase.co');
  });
});
