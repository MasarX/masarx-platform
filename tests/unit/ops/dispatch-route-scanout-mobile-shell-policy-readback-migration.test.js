const fs = require('fs');
const path = require('path');

const migrationName = '202607010835_dispatch_route_scanout_mobile_shell_policy_readback_v1.sql';
const migrationPath = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', migrationName);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
}

function functionBody(sql) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.resolve_mobile_shell_policy');
  const end = sql.indexOf('COMMENT ON FUNCTION public.resolve_mobile_shell_policy', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch route scanout mobile shell policy readback migration', () => {
  test('adds the aggregate Mobile V2 shell policy contract expected by runtime proof', () => {
    const sql = readMigration();

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.resolve_mobile_shell_policy');
    expect(sql).toContain('p_active_role TEXT DEFAULT');
    expect(sql).toContain("p_context JSONB DEFAULT '{}'::jsonb");
    expect(sql).toContain('RETURNS JSONB');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO public, extensions, pg_temp");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) FROM anon');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) TO authenticated, service_role');
  });

  test('composes readback from canonical policy resolvers without app-side fallback data', () => {
    const body = functionBody(readMigration());

    [
      'resolve_mobile_visibility_policy',
      'resolve_mobile_diagnostics_policy',
      'resolve_device_policy',
      'resolve_navigation_policy',
      'resolve_map_policy',
      'resolve_communication_policy',
      'resolve_address_policy',
      'resolve_driver_safety_policy',
      'resolve_ux_safety_policy',
      'resolve_mobile_push_policy',
      'resolve_mobile_attestation_policy',
      'resolve_mobile_sync_policy',
    ].forEach((resolver) => expect(body).toContain(resolver));

    expect(body).toContain("'active_role', v_active_role");
    expect(body).toMatch(/FROM public\.resolve_mobile_shell_policy_row\(jsonb_strip_nulls\(\s*jsonb_build_object\('organization_id', v_caller_org\)\s*\)\)/);
    expect(body).toMatch(/'v2_enabled', COALESCE\(\s*v_caller_org IS NOT NULL AND v_rollout\.scope_type = 'tenant'\s+AND v_rollout\.scope_id = v_caller_org\s+AND v_rollout\.value->'v2_enabled' = 'true'::jsonb\s+AND cardinality\(v_missing_categories\) = 0, FALSE\s*\)/);
    expect(body).toContain("'missing_categories', to_jsonb(v_missing_categories)");
    expect(body).toContain("'policies', v_policies");
    expect(body).not.toMatch(/@[a-z0-9.-]+/i);
    expect(body).not.toMatch(/support_contacts'\s*,\s*jsonb_build_array/i);
  });
});
