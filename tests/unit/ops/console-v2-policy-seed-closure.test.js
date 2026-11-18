const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const migration = fs.readFileSync(
  path.join(repoRoot, 'supabase', 'migrations', '202605041330_console_v2_policy_seed_closure_v1.sql'),
  'utf8',
);
const registrySeed = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'seed-raw', 'registry.js'),
  'utf8',
);
const policySeed = fs.readFileSync(
  path.join(repoRoot, 'apps', 'console-v2', 'src', 'lib', 'seed-raw', 'policies.js'),
  'utf8',
);

describe('Console V2 policy seed closure', () => {
  test('backs dispatch and observability settings with canonical database defaults', () => {
    for (const category of ['cod.float.max_per_driver', 'live_tail_policy']) {
      expect(migration).toContain(category);
      expect(registrySeed).toContain(category);
      expect(policySeed).toContain(category);
    }

    expect(migration).toContain('INSERT INTO public.settings_category_registry');
    expect(migration).toContain('INSERT INTO public.schema_registry');
    expect(migration).toContain('requires_global_default');
    expect(migration).toMatch(/safe_missing_behavior[\s\S]*'hard_fail'/);
    expect(migration).toMatch(/allowed_scopes[\s\S]*'\["global","tenant"\]'::jsonb/);
  });

  test('uses append-only settings writes only when a global value is missing or changed', () => {
    expect(migration).toContain("SELECT pg_advisory_lock(hashtext('202605041330_console_v2_policy_seed_closure_v1'))");
    expect(migration).toContain("SELECT pg_advisory_unlock(hashtext('202605041330_console_v2_policy_seed_closure_v1'))");
    expect(migration).toContain('public.upsert_settings_value_v1');
    expect(migration).toMatch(/s\.scope_type = 'global'[\s\S]*s\.scope_id IS NULL/);
    expect(migration).toMatch(/s\.cached_value IS NOT DISTINCT FROM v_cod_float/);
    expect(migration).toMatch(/s\.cached_value IS NOT DISTINCT FROM v_live_tail/);
    expect(migration).not.toMatch(/UPDATE\s+public\.settings_versions/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.settings\s/i);
  });
});
