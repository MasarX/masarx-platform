const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  persistSelectedDbEnvToExplicitFile,
  upsertEnvFileValues,
} = require('../../../scripts/ops/verify-cloud-core');

describe('verify-cloud-core explicit env persistence', () => {
  test('upsertEnvFileValues updates managed keys and preserves unrelated content', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-verify-core-'));
    const envFile = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=old-dsn\nOTHER_KEY=keep-me\n', 'utf8');

    const changed = upsertEnvFileValues(envFile, {
      DATABASE_URL: 'new-dsn',
      PG_CONN_STRING: 'new-dsn',
      DATABASE_URL_SELECTED_DSN_NAME: 'DATABASE_URL_DIRECT+hostaddr',
    });

    expect(changed).toBe(true);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(
      [
        'DATABASE_URL=new-dsn',
        'OTHER_KEY=keep-me',
        '',
        'PG_CONN_STRING=new-dsn',
        'DATABASE_URL_SELECTED_DSN_NAME=DATABASE_URL_DIRECT+hostaddr',
        '',
      ].join('\n'),
    );
  });

  test('persistSelectedDbEnvToExplicitFile pins selected dsn into explicit env file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-verify-core-'));
    const envFile = path.join(tempDir, 'preview.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=stale-dsn\nEXTRA_KEY=keep\n', 'utf8');
    const logger = { log: jest.fn() };

    const result = persistSelectedDbEnvToExplicitFile({
      explicitEnvFile: envFile,
      selectedDsn: 'postgresql://fresh',
      selectedCandidateName: 'DATABASE_URL_POOLER+hostaddr',
      logger,
    });

    expect(result).toEqual({
      persisted: true,
      envFile: envFile.replace(/\\/g, '/'),
    });
    expect(fs.readFileSync(envFile, 'utf8')).toBe(
      [
        'DATABASE_URL=postgresql://fresh',
        'EXTRA_KEY=keep',
        '',
        'PG_CONN_STRING=postgresql://fresh',
        'DB_SMOKE_SELECTED_DSN_NAME=DATABASE_URL_POOLER+hostaddr',
        'DATABASE_URL_SELECTED_DSN_NAME=DATABASE_URL_POOLER+hostaddr',
        '',
      ].join('\n'),
    );
    expect(logger.log).toHaveBeenCalledWith(
      `[verify:cloud:core] Persisted smoke-selected DATABASE_URL to explicit ENV_FILE (${envFile.replace(/\\/g, '/')}) using DATABASE_URL_POOLER+hostaddr.`,
    );
  });

  test('persistSelectedDbEnvToExplicitFile no-ops when no explicit env file is available', () => {
    const originalEnvFile = process.env.ENV_FILE;
    delete process.env.ENV_FILE;

    try {
      const result = persistSelectedDbEnvToExplicitFile({
        explicitEnvFile: '',
        selectedDsn: 'postgresql://fresh',
        logger: { log: jest.fn() },
      });

      expect(result).toEqual({
        persisted: false,
        reason: 'missing_env_file',
      });
    } finally {
      if (originalEnvFile === undefined) {
        delete process.env.ENV_FILE;
      } else {
        process.env.ENV_FILE = originalEnvFile;
      }
    }
  });

  test('persistSelectedDbEnvToExplicitFile reports env_file_missing when ENV_FILE points to a missing file', () => {
    const originalEnvFile = process.env.ENV_FILE;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-verify-core-'));
    const missingEnvFile = path.join(tempDir, 'missing.env');

    process.env.ENV_FILE = missingEnvFile;

    try {
      const result = persistSelectedDbEnvToExplicitFile({
        explicitEnvFile: '',
        selectedDsn: 'postgresql://fresh',
        logger: { log: jest.fn() },
      });

      expect(result).toEqual({
        persisted: false,
        reason: 'env_file_missing',
        envFile: missingEnvFile.replace(/\\/g, '/'),
      });
    } finally {
      if (originalEnvFile === undefined) {
        delete process.env.ENV_FILE;
      } else {
        process.env.ENV_FILE = originalEnvFile;
      }
    }
  });
});
