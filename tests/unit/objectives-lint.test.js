const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const lintScript = path.join(repoRoot, 'scripts', 'ops', 'objectives-lint.js');
const tmpRoot = path.join(repoRoot, 'scripts', 'tmp', 'tests', 'objectives-lint');

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

function runLint(includePath) {
  return spawnSync(process.execPath, [lintScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: buildChildEnv({ OBJECTIVES_LINT_INCLUDE: `^${escapeForRegex(includePath)}` })
  });
}

function createTmpFile(label, body) {
  const caseId = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(tmpRoot, caseId);
  const file = path.join(dir, `${caseId}.js`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return {
    dir,
    includePath: path.relative(repoRoot, dir),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe('objectives-lint', () => {
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('detects localhost literals', () => {
    const tmp = createTmpFile('localhost-literal', 'fetch("http://localhost:5432/health")');
    try {
      const res = runLint(tmp.includePath);
      expect(res.status).not.toBe(0);
      expect((res.stderr || res.stdout || '')).toMatch(/LOCALHOST/);
    } finally {
      tmp.cleanup();
    }
  });

  test('suppression comment allows localhost with justification', () => {
    const src = [
      '// objectives:allow LOCALHOST Justification: test scaffold',
      'const url = "http://localhost:8080";'
    ].join('\n');
    const tmp = createTmpFile('localhost-suppressed', src);
    try {
      const res = runLint(tmp.includePath);
      expect(res.status).toBe(0);
      const combined = `${res.stderr || ''}\n${res.stdout || ''}`;
      expect(combined).toMatch(/RLS Missing summary: baseline=0 net_new=0/);
      expect(combined).toMatch(/Policy Missing summary: baseline=0 net_new=0/);
      expect(combined).toMatch(/no objective violations/i);
    } finally {
      tmp.cleanup();
    }
  });
});
