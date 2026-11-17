const fs = require('fs');
const os = require('os');
const path = require('path');

function createMissingDotenvError() {
  const error = new Error("Cannot find module 'dotenv'");
  error.code = 'MODULE_NOT_FOUND';
  return error;
}

describe('utils/load-env', () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  beforeEach(() => {
    jest.resetModules();
    jest.unmock('dotenv');
    process.env = { ...originalEnv };
    delete process.env.ENV_FILE;
    delete process.env.ENV_FILE_APPEND;
    delete process.env.ENV_FILE_OVERRIDE;
    delete process.env.LOAD_ENV_VERBOSE;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    jest.unmock('dotenv');
  });

  function withTempRepo(run) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-load-env-'));
    process.chdir(repoRoot);
    try {
      run(repoRoot);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  test('loadEnv falls back to the built-in parser when dotenv is unavailable', () => {
    withTempRepo((repoRoot) => {
      const explicitEnv = path.join(repoRoot, '.tmp.explicit.env');
      fs.writeFileSync(
        explicitEnv,
        [
          'EXISTING=from-explicit',
          'QUOTED="hello world"',
          'COMMENTED=value # trailing comment',
          '',
        ].join('\n'),
        'utf8',
      );
      process.env.ENV_FILE = explicitEnv;
      process.env.ENV_FILE_OVERRIDE = '1';
      process.env.EXISTING = 'from-process';

      jest.doMock('dotenv', () => {
        throw createMissingDotenvError();
      });

      let loadEnv;
      jest.isolateModules(() => {
        ({ loadEnv } = require('../../../scripts/utils/load-env'));
      });

      loadEnv();

      expect(process.env.EXISTING).toBe('from-explicit');
      expect(process.env.QUOTED).toBe('hello world');
      expect(process.env.COMMENTED).toBe('value');
    });
  });

  test('loadEnv preserves explicit env values without override when dotenv is unavailable', () => {
    withTempRepo((repoRoot) => {
      const explicitEnv = path.join(repoRoot, '.tmp.explicit.env');
      fs.writeFileSync(
        explicitEnv,
        [
          'EXISTING=from-explicit',
          'NEW_VALUE=from-explicit',
          '',
        ].join('\n'),
        'utf8',
      );
      process.env.ENV_FILE = explicitEnv;
      process.env.EXISTING = 'from-process';

      jest.doMock('dotenv', () => {
        throw createMissingDotenvError();
      });

      let loadEnv;
      jest.isolateModules(() => {
        ({ loadEnv } = require('../../../scripts/utils/load-env'));
      });

      loadEnv();

      expect(process.env.EXISTING).toBe('from-process');
      expect(process.env.NEW_VALUE).toBe('from-explicit');
    });
  });

  test('loadEnv fallback preserves existing env without override during default resolution', () => {
    withTempRepo((repoRoot) => {
      const envDir = path.join(repoRoot, 'config', 'env');
      fs.mkdirSync(envDir, { recursive: true });
      fs.writeFileSync(
        path.join(envDir, '.env.cloud'),
        [
          'KEEP_ME=from-cloud',
          'NEW_VALUE=cloud-only',
          '',
        ].join('\n'),
        'utf8',
      );
      process.env.KEEP_ME = 'from-process';

      jest.doMock('dotenv', () => {
        throw createMissingDotenvError();
      });

      let loadEnv;
      jest.isolateModules(() => {
        ({ loadEnv } = require('../../../scripts/utils/load-env'));
      });

      loadEnv();

      expect(process.env.KEEP_ME).toBe('from-process');
      expect(process.env.NEW_VALUE).toBe('cloud-only');
    });
  });
});
