const fs = require('fs');
const path = require('path');

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260913001000_branch_zone_assign_concurrency_v1.sql',
);
const source = fs.readFileSync(migrationPath, 'utf8');
const functionSource = source.match(
  /CREATE OR REPLACE FUNCTION public\.branch_zone_assign_v1\(p_args JSONB\)([\s\S]*?)\n\$\$;/,
)?.[0] || '';

describe('branch zone assignment concurrency migration', () => {
  test('serializes the canonical unique zone identity after authorization and before lookup', () => {
    expect(functionSource).toContain("assert_capability_v1('agreements.write')");
    expect(functionSource).toContain('branch % outside tenant scope');
    expect(functionSource).toContain(
      "hashtextextended('branch_zone_assign:' || v_zone_id::text, 0)",
    );
    expect(functionSource.match(/hashtextextended\('branch_zone_assign:'/g)).toHaveLength(1);
    expect(functionSource).not.toContain('pg_advisory_unlock');

    const auth = functionSource.indexOf('branch % outside tenant scope');
    const lock = functionSource.indexOf("hashtextextended('branch_zone_assign:'");
    const lookup = functionSource.indexOf('FROM public.branch_zones');
    expect(lock).toBeGreaterThan(auth);
    expect(lookup).toBeGreaterThan(lock);
    expect(functionSource).toContain('INSERT INTO public.branch_zones');
    expect(functionSource).toContain('already_assigned');
    expect(functionSource).toContain("USING ERRCODE = '23505'");
    expect(functionSource).toContain('public.log_decision');
  });
});
