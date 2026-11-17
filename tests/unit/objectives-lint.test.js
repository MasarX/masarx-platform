const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sourceRoot = path.resolve(__dirname, '..', '..');
const lintScript = path.join(sourceRoot, 'scripts', 'ops', 'objectives-lint.js');
let repoRoot;
let tmpRoot;

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

function runLint(includePath, env = {}) {
  return spawnSync(process.execPath, [lintScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: buildChildEnv({
      OBJECTIVES_LINT_INCLUDE: `^${escapeForRegex(includePath)}`,
      ...env,
    })
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
  beforeAll(() => {
    // Other suites discover live repository writers; keep all transient fixtures outside that tree.
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'objectives-lint-'));
    tmpRoot = path.join(repoRoot, 'scripts', 'tmp', 'tests', 'objectives-lint');
    for (const file of ['.gitignore', 'config/ci/objectives-lint-baseline.json',
      'supabase/functions/_shared/turnstile-local-test.mjs']) {
      const destination = path.join(repoRoot, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, file), destination);
    }
    expect(spawnSync('git', ['init', '--quiet'], { cwd: repoRoot }).status).toBe(0);
  });

  afterAll(() => {
    if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  test('ignores generated reports and still catches fixed endpoints', () => {
    const dir = path.join(repoRoot, 'playwright-report', `lint-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trace.js'), 'fetch("http://localhost:5432")');
    try {
      expect(runLint(path.relative(repoRoot, dir)).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const tmp = createTmpFile('fixed-endpoints', [
      ('const dsn = "' + ['postgresql',":","/","/",'user',":",'password',"@",'db.example',"/",'db'].join("") + '";'),
      'const issuer = "https://fixedref.supabase.co/auth/v1";',
      'fetch("http://localhost:5432");',
    ].join('\n'));
    try {
      const result = runLint(tmp.includePath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/DSN_URL/);
      expect(result.stderr).toMatch(/SUPABASE_URL/);
      expect(result.stderr).toMatch(/LOCALHOST/);
    } finally {
      tmp.cleanup();
    }
  });
  test('skips only untracked ignored shared mirrors', () => {
    const canonical = path.join(repoRoot, 'supabase', 'functions', '_shared', 'turnstile-local-test.mjs');
    const dir = path.join(repoRoot, 'supabase', 'functions', `objectives-lint-${process.pid}-${Date.now()}`, '_shared');
    const mirror = path.join(dir, 'turnstile-local-test.mjs');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(canonical, mirror);
    const rel = path.relative(repoRoot, mirror).replace(/\\/g, '/');
    try {
      expect(runLint(rel).status).toBe(0);
      expect(runLint(rel, { OBJECTIVES_LINT_EXPECTED_FILES_JSON: JSON.stringify([rel]) }).stderr)
        .toMatch(/Coverage mismatch/);
      const indexFile = path.join(dir, 'isolated-git-index');
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      expect(spawnSync('git', ['add', '-f', '--', rel], { cwd: repoRoot, env }).status).toBe(0);
      const tracked = runLint(rel, { GIT_INDEX_FILE: indexFile, OBJECTIVES_LINT_EXPECTED_FILES_JSON: JSON.stringify([rel]) });
      expect(tracked.status).toBe(0);
      expect(tracked.stdout).toMatch(/Coverage verified: selected=1 scanned=1/);
      fs.appendFileSync(mirror, '\nfetch("http://localhost:5432");\n');
      expect(runLint(rel).status).toBe(0);
      const direct = path.join(path.dirname(dir), 'source.mjs');
      fs.writeFileSync(direct, 'fetch("http://localhost:5432");');
      expect(runLint(path.relative(repoRoot, direct)).stderr).toMatch(/LOCALHOST/);
      const canonicalRel = path.relative(repoRoot, canonical).replace(/\\/g, '/');
      const canonicalScan = runLint(canonicalRel, { OBJECTIVES_LINT_EXPECTED_FILES_JSON: JSON.stringify([canonicalRel]) });
      expect(canonicalScan.stdout).toMatch(/Coverage verified: selected=1 scanned=1/);
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });


  test('accepts redacted DSN and dynamic Supabase issuer', () => {
    const tmp = createTmpFile('dynamic-endpoints', [
      'const output = "postgresql://[redacted]";',
      'const issuer = `https://${projectRef}.supabase.co/auth/v1`;',
    ].join('\n'));
    try {
      expect(runLint(tmp.includePath).status).toBe(0);
    } finally {
      tmp.cleanup();
    }
  });

  test('does not excuse a DSN with a redacted prefix and live suffix', () => {
    const tmp = createTmpFile('redacted-prefix-live-dsn', 'const dsn = "postgresql://[redacted]@db.example/db";');
    try {
      const result = runLint(tmp.includePath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/DSN_URL/);
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

  test('fails closed when selected and scanned file coverage differs', () => {
    const tmp = createTmpFile('coverage-mismatch', 'const ok = true;\n');
    try {
      const selected = `${tmp.includePath.replace(/\\/g, '/')}/missing.js`;
      const res = runLint(tmp.includePath, {
        OBJECTIVES_LINT_EXPECTED_FILES_JSON: JSON.stringify([selected]),
      });
      expect(res.status).not.toBe(0);
      expect(`${res.stderr || ''}\n${res.stdout || ''}`).toMatch(/Coverage mismatch/);
    } finally {
      tmp.cleanup();
    }
  });

  test('records exact selected and scanned file coverage', () => {
    const tmp = createTmpFile('coverage-exact', 'const ok = true;\n');
    try {
      const selected = fs.readdirSync(tmp.dir)
        .map((name) => `${tmp.includePath.replace(/\\/g, '/')}/${name}`);
      const res = runLint(tmp.includePath, {
        OBJECTIVES_LINT_EXPECTED_FILES_JSON: JSON.stringify(selected),
      });
      expect(res.status).toBe(0);
      expect(`${res.stderr || ''}\n${res.stdout || ''}`).toMatch(
        /Coverage verified: selected=1 scanned=1/,
      );
    } finally {
      tmp.cleanup();
    }
  });
});
