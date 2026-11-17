const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  ensureWorkspaceEnv,
} = require('../../../scripts/ops/workspace/env-bootstrap');

function makeLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
  };
}

function ensureEnvDir(root) {
  fs.mkdirSync(path.join(root, 'config', 'env'), { recursive: true });
}

describe('workspace env-bootstrap', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-bootstrap-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('parseArgs reads strict and source options', () => {
    const parsed = parseArgs(['--strict', '--source', '/tmp/source'], {});
    expect(parsed.strict).toBe(true);
    expect(parsed.sourceRoot).toBe(path.resolve('/tmp/source'));
  });

  test('returns advisory skip when primary root cannot be resolved and required files are missing', () => {
    const cwd = path.join(tmpRoot, 'workspace');
    ensureEnvDir(cwd);
    const logger = makeLogger();

    const result = ensureWorkspaceEnv({
      cwd,
      strict: false,
      logger,
      spawnSyncImpl: () => ({ status: 1, stdout: '' }),
    });

    expect(result.status).toBe('advisory_skip');
    expect(result.missingRequired).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('fails in strict mode when required files cannot be seeded', () => {
    const cwd = path.join(tmpRoot, 'workspace-strict');
    ensureEnvDir(cwd);
    const logger = makeLogger();

    const result = ensureWorkspaceEnv({
      cwd,
      strict: true,
      logger,
      spawnSyncImpl: () => ({ status: 1, stdout: '' }),
    });

    expect(result.status).toBe('failed');
    expect(result.missingRequired).toHaveLength(2);
  });

  test('copies missing env files from source root and scrubs .env.cloud', () => {
    const sourceRoot = path.join(tmpRoot, 'primary');
    const cwd = path.join(tmpRoot, 'worker');
    ensureEnvDir(sourceRoot);
    ensureEnvDir(cwd);
    fs.writeFileSync(path.join(sourceRoot, 'config', 'env', '.env'), 'DATABASE_URL=postgres://example\n', 'utf8');
    fs.writeFileSync(path.join(sourceRoot, 'config', 'env', '.env.cloud'), 'SUPABASE_URL=https://example.supabase.co\n', 'utf8');
    const sanitizeSpy = jest.fn(() => true);

    const result = ensureWorkspaceEnv({
      cwd,
      strict: true,
      sourceRoot,
      logger: makeLogger(),
      sanitizeEnvCloudImpl: sanitizeSpy,
    });

    expect(result.status).toBe('success');
    expect(result.copied).toHaveLength(2);
    expect(fs.readFileSync(path.join(cwd, 'config', 'env', '.env'), 'utf8')).toContain('DATABASE_URL=');
    expect(fs.readFileSync(path.join(cwd, 'config', 'env', '.env.cloud'), 'utf8')).toContain('SUPABASE_URL=');
    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
  });

  test('does not fail when local env files already exist and primary root is unavailable', () => {
    const cwd = path.join(tmpRoot, 'workspace-ready');
    ensureEnvDir(cwd);
    fs.writeFileSync(path.join(cwd, 'config', 'env', '.env'), 'EXISTING=1\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'config', 'env', '.env.cloud'), 'EXISTING_CLOUD=1\n', 'utf8');

    const result = ensureWorkspaceEnv({
      cwd,
      strict: true,
      logger: makeLogger(),
      spawnSyncImpl: () => ({ status: 1, stdout: '' }),
    });

    expect(result.status).toBe('success');
    expect(result.missingRequired).toHaveLength(0);
  });

  test('strict mode fails when source root is missing one required file', () => {
    const sourceRoot = path.join(tmpRoot, 'primary-missing');
    const cwd = path.join(tmpRoot, 'worker-missing');
    ensureEnvDir(sourceRoot);
    ensureEnvDir(cwd);
    fs.writeFileSync(path.join(sourceRoot, 'config', 'env', '.env'), 'ONLY_ENV=1\n', 'utf8');

    const result = ensureWorkspaceEnv({
      cwd,
      strict: true,
      sourceRoot,
      logger: makeLogger(),
      sanitizeEnvCloudImpl: jest.fn(() => false),
    });

    expect(result.status).toBe('failed');
    expect(result.missingRequired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relPath: path.join('config', 'env', '.env.cloud'),
        }),
      ])
    );
  });
});
