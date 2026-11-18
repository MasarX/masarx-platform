-- pgTAP: Console V2 organizations registry is tenant-scoped for shared UI reads.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org_one UUID := gen_random_uuid();
  v_org_two UUID := gen_random_uuid();
  v_tenant_user UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org_one, 'Console Scope Guard One', 'console-scope-one-' || left(v_org_one::text, 8)),
    (v_org_two, 'Console Scope Guard Two', 'console-scope-two-' || left(v_org_two::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (
      v_tenant_user,
      v_org_one,
      'console-scope-tenant-' || left(v_tenant_user::text, 8) || '@example.com',
      'Console Scope Tenant',
      'ops_admin',
      'tenant',
      NULL
    ),
    (
      v_platform_user,
      v_org_one,
      'console-scope-platform-' || left(v_platform_user::text, 8) || '@example.com',
      'Console Scope Platform',
      'super_admin',
      'platform',
      NULL
    );

  PERFORM ok(
    NOT EXISTS (
      SELECT 1
        FROM public.settings s
        JOIN public.settings_versions sv ON sv.id = s.settings_version_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS r(resource)
       WHERE s.category = 'ui_read_registry'
         AND r.resource->>'key' = 'organizations'
         AND COALESCE(r.resource#>>'{scope_columns,tenant}', '') <> 'id'
    ),
    'every active organizations read-registry row has tenant scope column id'
  );

  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := public.ui_list_resource_v1('organizations', '{}'::jsonb, 100, 0, NULL);

  PERFORM is(
    (SELECT count(*)::INT FROM jsonb_array_elements(COALESCE(v_result->'items', '[]'::jsonb))),
    1,
    'tenant-scoped ui_list_resource_v1(organizations) returns one organization'
  );
  PERFORM is(
    (SELECT count(*)::INT FROM jsonb_array_elements(COALESCE(v_result->'items', '[]'::jsonb)) AS item WHERE item->>'id' = v_org_one::text),
    1,
    'tenant-scoped organizations list contains the caller organization'
  );
  PERFORM is(
    (SELECT count(*)::INT FROM jsonb_array_elements(COALESCE(v_result->'items', '[]'::jsonb)) AS item WHERE item->>'id' = v_org_two::text),
    0,
    'tenant-scoped organizations list excludes other organizations'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := public.ui_list_resource_v1('organizations', '{}'::jsonb, 100, 0, NULL);
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_result->'items', '[]'::jsonb)) AS item
       WHERE item->>'id' = v_org_one::text
    )
    AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_result->'items', '[]'::jsonb)) AS item
       WHERE item->>'id' = v_org_two::text
    ),
    'platform-scoped organizations list still includes multiple organizations'
  );
  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
