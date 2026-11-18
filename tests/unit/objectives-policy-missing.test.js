const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const lintScript = path.join(repoRoot, 'scripts', 'ops', 'objectives-lint.js');
const tmpRoot = path.join(repoRoot, 'scripts', 'tmp', 'tests', 'objectives-policy-missing');

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

function runLint(includePath, extraEnv = {}) {
  return spawnSync(process.execPath, [lintScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: buildChildEnv({
      OBJECTIVES_LINT_INCLUDE: `^${escapeForRegex(includePath)}`,
      ...extraEnv,
    })
  });
}

function writeTmpSql(name, sql) {
  const caseId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(tmpRoot, caseId);
  const file = path.join(dir, `${caseId}.sql`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, sql, 'utf8');
  return {
    dir,
    includePath: path.relative(repoRoot, file),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function runLintUntil(predicate, includePath, extraEnv = {}, attempts = 3) {
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResult = runLint(includePath, extraEnv);
    if (predicate(lastResult)) {
      return lastResult;
    }
  }
  return lastResult;
}

describe('objectives-lint POLICY_MISSING', () => {
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('POLICY_MISSING fails on net-new findings by default', () => {
    const sql = `CREATE TABLE public.demo_p (id int);\nALTER TABLE public.demo_p ENABLE ROW LEVEL SECURITY;\n`;
    const tmp = writeTmpSql('policy-missing-default', sql);
    try {
      const res = runLintUntil((result) => result.status !== 0, tmp.includePath);
      expect(res.status).not.toBe(0);
      expect((res.stderr || res.stdout || '')).toMatch(/Policy Missing summary: baseline=0 net_new=1/);
    } finally {
      tmp.cleanup();
    }
  });

  test('POLICY_MISSING can run in warn mode for local triage', () => {
    const sql = `CREATE TABLE public.demo_p_warn (id int);\nALTER TABLE public.demo_p_warn ENABLE ROW LEVEL SECURITY;\n`;
    const tmp = writeTmpSql('policy-missing-warn', sql);
    try {
      const res = runLintUntil(
        (result) => result.status === 0
          && /Policy Missing summary: baseline=0 net_new=1/.test(result.stderr || result.stdout || ''),
        tmp.includePath,
        { OBJECTIVES_LINT_NET_NEW_MODE: 'warn' }
      );
      expect(res.status).toBe(0);
      expect((res.stderr || res.stdout || '')).toMatch(/Policy Missing summary: baseline=0 net_new=1/);
    } finally {
      tmp.cleanup();
    }
  });

  test('POLICY_MISSING fails when enforced', () => {
    const sql = `CREATE TABLE public.demo_p2 (id int);\nALTER TABLE public.demo_p2 ENABLE ROW LEVEL SECURITY;\n`;
    const tmp = writeTmpSql('policy-missing-enforced', sql);
    try {
      const res = runLintUntil(
        (result) => result.status !== 0,
        tmp.includePath,
        { OBJECTIVES_ENFORCE_POLICY_MISSING: '1' }
      );
      expect(res.status).not.toBe(0);
      expect((res.stderr || res.stdout || '')).toMatch(/Policy Missing \(enforced\)/);
    } finally {
      tmp.cleanup();
    }
  });

  test('historical private reassignment table stays deny-only', () => {
    const creationRel = 'supabase/migrations/202609060200_fieldops_reassignment_request_workflow_v1.sql';
    const completionRel = 'supabase/migrations/20260909151000_private_table_contract_completion_v1.sql';
    const table = 'public.fieldops_reassignment_requests';
    const key = `${creationRel}|${table}`;
    const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/ci/objectives-lint-baseline.json'), 'utf8'));
    const creation = fs.readFileSync(path.join(repoRoot, creationRel), 'utf8');
    const completion = fs.readFileSync(path.join(repoRoot, completionRel), 'utf8');
    expect(creationRel < completionRel).toBe(true);
    expect(baseline.policy_missing.filter((entry) => entry === key)).toEqual([key]);
    expect(creation).toMatch(/CREATE TABLE public\.fieldops_reassignment_requests\s*\(/i);
    expect(creation).toMatch(/ALTER TABLE public\.fieldops_reassignment_requests ENABLE ROW LEVEL SECURITY/i);
    expect(creation).toMatch(/REVOKE ALL ON public\.fieldops_reassignment_requests FROM PUBLIC, anon, authenticated, service_role/i);
    expect(completion).toMatch(/CREATE POLICY fieldops_reassignment_requests_service_private\s+ON public\.fieldops_reassignment_requests\s+FOR ALL TO service_role USING \(FALSE\) WITH CHECK \(FALSE\)/i);
    const result = runLint(creationRel, {
      OBJECTIVES_ENFORCE_POLICY_MISSING: '0',
      OBJECTIVES_LINT_NET_NEW_MODE: 'error',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/Policy Missing summary: baseline=1 net_new=0/);
  });
});
