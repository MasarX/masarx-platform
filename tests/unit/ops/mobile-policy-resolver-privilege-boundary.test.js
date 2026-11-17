const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const migrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '202607151150_mobile_policy_resolver_privilege_boundary_v1.sql',
);

const browserReadableWrapperNames = [
  'resolve_location_tracking_policy',
  'resolve_scan_policy',
  'resolve_pod_policy',
  'resolve_mobile_sync_policy',
];

describe('Mobile policy resolver privilege boundary migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  test('uses exactly the intended four-name definer allowlist', () => {
    const allowlistBlock = migration.match(
      /FOREACH v_function_name IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/,
    );
    expect(allowlistBlock).not.toBeNull();
    const actualNames = [...allowlistBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(actualNames).toEqual(browserReadableWrapperNames);
  });

  test('keeps Mobile ingest internal and service-role only', () => {
    expect(migration).toMatch(
      /ALTER FUNCTION public\.resolve_mobile_ingest_policy\(JSONB\) SECURITY INVOKER;/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.resolve_mobile_ingest_policy\(JSONB\) FROM authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_mobile_ingest_policy\(JSONB\) TO service_role;/,
    );
  });

  test('uses a pinned definer boundary and exact browser-role grants', () => {
    expect(migration).toContain("'ALTER FUNCTION public.%I(JSONB) SECURITY DEFINER'");
    expect(migration).toContain(
      "'ALTER FUNCTION public.%I(JSONB) SET search_path TO public, extensions, pg_temp'",
    );
    expect(migration).toContain(
      "'REVOKE ALL ON FUNCTION public.%I(JSONB) FROM PUBLIC'",
    );
    expect(migration).toContain("'REVOKE ALL ON FUNCTION public.%I(JSONB) FROM anon'");
    expect(migration).toContain(
      "'GRANT EXECUTE ON FUNCTION public.%I(JSONB) TO authenticated, service_role'",
    );
  });

  test('keeps the generic resolver service-role only', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.resolve_settings_row_from_policy_context_v1\(TEXT, JSONB\)[\s\S]*FROM authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_settings_row_from_policy_context_v1\(TEXT, JSONB\)[\s\S]*TO service_role;/,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_settings_row_from_policy_context_v1\(TEXT, JSONB\)[\s\S]*TO authenticated/,
    );
  });
});
