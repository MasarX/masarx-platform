const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lint = path.resolve(__dirname, '../../scripts/ops/objectives-lint.js');

test.each([
  ["SELECT public.enforce_service_only_rls_v1('public.snapshot'::regclass);", 0],
  ["DO $$ BEGIN\n PERFORM public.enforce_service_only_rls_v1('public.snapshot'::regclass);\nEND $$;", 0],
  ["SELECT public.enforce_service_only_rls_v1('other.snapshot'::regclass);", 1],
  ["SELECT public.enforce_service_only_rls_v1('public.other'::regclass);", 1],
  ["-- SELECT public.enforce_service_only_rls_v1('public.snapshot'::regclass);", 1],
  ["/*\n SELECT public.enforce_service_only_rls_v1('public.snapshot'::regclass);\n*/", 1],
  ["SELECT public.enforce_service_only_rls_v1(relation_variable);", 1],
])('objectives service-only proof: %s', (call, expected) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-objectives-service-'));
  try {
    fs.writeFileSync(path.join(root, 'case.sql'), `CREATE TABLE public.snapshot(id int);\n${call}\n`);
    const result = spawnSync(process.execPath, [lint], { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, OBJECTIVES_LINT_INCLUDE: '^case\\.sql$', OBJECTIVES_ENFORCE_RLS_MISSING: '1',
        OBJECTIVES_ENFORCE_POLICY_MISSING: '1', OBJECTIVES_LINT_EXPECTED_FILES_JSON: '["case.sql"]' } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(expected);
    if (expected) expect(result.stderr).toContain('[RLS_MISSING]');
    else expect(result.stdout).toContain('Coverage verified: selected=1 scanned=1');
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
