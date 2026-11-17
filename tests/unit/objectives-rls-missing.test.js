const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const lintScript = path.join(repoRoot, 'scripts', 'ops', 'objectives-lint.js');
const tmpRoot = path.join(repoRoot, 'scripts', 'tmp', 'tests', 'objectives-rls-missing');

function escapeForRegex(input) {
  return String(input || '').replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'NODE_OPTIONS' || key.startsWith('OBJECTIVES_')) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function createTmpSql(name, sql) {
  const caseId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(tmpRoot, caseId);
  const file = path.join(dir, `${caseId}.sql`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, sql, 'utf8');
  return {
    dir,
    includePattern: `^${escapeForRegex(path.relative(repoRoot, file))}$`,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function runLintUntil(predicate, envOverrides = {}, attempts = 3) {
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResult = spawnSync(process.execPath, [lintScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: buildChildEnv(envOverrides)
    });
    if (predicate(lastResult)) {
      return lastResult;
    }
  }
  return lastResult;
}

describe('objectives-lint RLS_MISSING', () => {
  beforeAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  test('RLS_MISSING fails on net-new findings by default', () => {
    const tmp = createTmpSql('rls-missing-default', 'CREATE TABLE public.demo (id int);\n');
    try {
      const res = runLintUntil((result) => result.status !== 0, {
        OBJECTIVES_LINT_INCLUDE: tmp.includePattern
      });
      expect(res.status).not.toBe(0);
      expect((res.stderr || res.stdout || '')).toMatch(/RLS Missing summary: baseline=0 net_new=1/);
    } finally {
      tmp.cleanup();
    }
  });

  test('RLS_MISSING can run in warn mode for local triage', () => {
    const tmp = createTmpSql('rls-missing-warn', 'CREATE TABLE public.demo_warn (id int);\n');
    try {
      const res = runLintUntil(
        (result) => result.status === 0
          && /RLS Missing summary: baseline=0 net_new=1/.test(result.stderr || result.stdout || ''),
        {
          OBJECTIVES_LINT_INCLUDE: tmp.includePattern,
          OBJECTIVES_LINT_NET_NEW_MODE: 'warn'
        }
      );
      expect(res.status).toBe(0);
      expect((res.stderr || res.stdout || '')).toMatch(/RLS Missing summary: baseline=0 net_new=1/);
    } finally {
      tmp.cleanup();
    }
  });

  test('RLS_MISSING fails when enforced', () => {
    const tmp = createTmpSql('rls-missing-enforced', 'CREATE TABLE public.demo2 (id int);\n');
    try {
      const res = runLintUntil((result) => result.status !== 0, {
        OBJECTIVES_LINT_INCLUDE: tmp.includePattern,
        OBJECTIVES_ENFORCE_RLS_MISSING: '1'
      });
      expect(res.status).not.toBe(0);
      expect((res.stderr || res.stdout || '')).toMatch(/RLS Missing \(enforced\)/);
    } finally {
      tmp.cleanup();
    }
  });
});
