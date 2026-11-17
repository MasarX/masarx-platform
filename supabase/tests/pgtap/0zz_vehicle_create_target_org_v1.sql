-- pgTAP: Console platform-led tenant operations must create vehicles in
-- the selected tenant, while normal tenant users remain scoped to their org.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(22);

SELECT has_function(
  'api',
  'create_vehicle_v1',
  ARRAY['jsonb'],
  'api.create_vehicle_v1(jsonb) exists for browser Supabase clients'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.create_vehicle_v1(jsonb)', 'EXECUTE'),
  'authenticated users can execute api.create_vehicle_v1 through capability gates'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.create_vehicle_v1(jsonb)')) ~ 'p_args->>''organization_id''',
  'create_vehicle_v1 accepts an explicit organization_id target'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.create_vehicle_v1(jsonb)')) ~ 'NOT public\.is_platform_user\(\)',
  'create_vehicle_v1 permits cross-tenant targeting only for platform users'
);

CREATE OR REPLACE FUNCTION pg_temp.test_console_platform_create_vehicle_target_org()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_platform_org UUID := '57140461-2e69-4c86-8140-011ec18f7c00'::uuid;
  v_target_org UUID := '57140461-2e69-4c86-8140-011ec18f7c01'::uuid;
  v_other_org UUID := '57140461-2e69-4c86-8140-011ec18f7c02'::uuid;
  v_platform_user UUID := '57140461-2e69-4c86-8140-011ec18f7c10'::uuid;
  v_tenant_user UUID := '57140461-2e69-4c86-8140-011ec18f7c12'::uuid;
  v_target_branch UUID := '57140461-2e69-4c86-8140-011ec18f7c20'::uuid;
  v_other_branch UUID := '57140461-2e69-4c86-8140-011ec18f7c21'::uuid;
  v_target_type UUID := '57140461-2e69-4c86-8140-011ec18f7c30'::uuid;
  v_other_type UUID := gen_random_uuid();
  v_inactive_type UUID := gen_random_uuid();
  v_rows JSONB;
  v_policy JSONB;
  v_policy_version INT;
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_platform_org, 'Console Vehicle Platform Org', 'console-vehicle-platform-org'),
    (v_target_org, 'Console Vehicle Target Org', 'console-vehicle-target-org'),
    (v_other_org, 'Console Vehicle Other Org', 'console-vehicle-other-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_target_branch, v_target_org, 'vehicle-target-main', 'Vehicle Target Branch', 'UTC', TRUE),
    (v_other_branch, v_other_org, 'vehicle-other-main', 'Vehicle Other Branch', 'UTC', TRUE)
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      code = EXCLUDED.code,
      name = EXCLUDED.name,
      is_active = EXCLUDED.is_active;

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_target_type, v_target_org, 'target-van', 'Target Van', TRUE)
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      key = EXCLUDED.key,
      name = EXCLUDED.name,
      is_active = EXCLUDED.is_active;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status
  )
  VALUES
    (
      v_platform_user,
      v_platform_org,
      'console-vehicle-platform@example.test',
      'Console Vehicle Platform Admin',
      'super_admin',
      'platform',
      NULL,
      'active'
    ),
    (
      v_tenant_user,
      v_other_org,
      'console-vehicle-tenant@example.test',
      'Console Vehicle Tenant Admin',
      'ops_admin',
      'tenant',
      NULL,
      'active'
    )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      status = EXCLUDED.status;

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::TEXT, TRUE);
  INSERT INTO public.vehicle_types(id,organization_id,key,name,is_active) VALUES
    (v_other_type,v_other_org,'f148-'||v_other_type,'F148 other type',TRUE),
    (v_inactive_type,v_target_org,'f148-'||v_inactive_type,'F148 inactive type',FALSE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_platform_user,
      'role', 'authenticated',
      'email', 'console-vehicle-platform@example.test'
    )::TEXT,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.create_vehicle_v1(
    -- Existing write remains authoritative; picker reads do not grant creation.
    jsonb_build_object(
      'organization_id', v_target_org,
      'plate_number', 'PGTAP-TARGET-VEHICLE',
      'vehicle_type_id', v_target_type,
      'branch_id', v_target_branch,
      'status', 'active'
    )
  ) INTO v_result;

  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::BOOLEAN, FALSE)
      AND v_result->>'organization_id' = v_target_org::TEXT
      AND v_result ? 'vehicle_id',
    'platform operator can create vehicle in selected active tenant'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.vehicles v
      WHERE v.organization_id = v_target_org
        AND v.branch_id = v_target_branch
        AND v.vehicle_type_id = v_target_type
        AND v.plate_number = 'PGTAP-TARGET-VEHICLE'
    ),
    'create_vehicle_v1 persists the vehicle under the selected tenant'
  );

  v_rows:=api.ui_list_resource_v1('vehicle_create_type_directory',jsonb_build_object('organization_id',v_target_org,'is_active',true),100,0,NULL);
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows->'items') e WHERE e->>'id'=v_target_type::text)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows->'items') e WHERE e->>'organization_id'<>v_target_org::text OR e->>'id'=v_inactive_type::text),
    'platform type picker contains active selected-tenant type and excludes foreign/inactive rows');
  v_rows:=api.ui_list_resource_v1('vehicle_create_branch_directory',jsonb_build_object('organization_id',v_target_org),100,0,NULL);
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows->'items') e WHERE e->>'id'=v_target_branch::text)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows->'items') e WHERE e->>'organization_id'<>v_target_org::text),
    'platform branch picker contains selected-tenant branch and excludes foreign rows');
  v_rows:=api.ui_get_resource_v1('organizations',v_target_org);
  RETURN NEXT is(v_rows->>'id',v_target_org::text,
    'platform organization directory permits exact selected-tenant readback without pagination assumptions');
  v_rows:=api.ui_list_resource_v1('vehicle_create_form_schema',jsonb_build_object('is_active',true),100,0,NULL);
  RETURN NEXT ok(jsonb_array_length(v_rows->'items')=1 AND v_rows->'items'->0->>'category'='vehicle_create_form_v1'
    AND jsonb_typeof(v_rows->'items'->0->'schema')='object','fleet reader receives exact active vehicle form schema');
  v_rows:=api.ui_list_resource_v1('vehicle_create_form_schema',jsonb_build_object('category','ui_read_registry'),100,0,NULL);
  RETURN NEXT is(jsonb_array_length(v_rows->'items'),0,'exact-schema view cannot disclose a different requested category');
  RETURN NEXT throws_ok(format('SELECT api.create_vehicle_v1(%L::jsonb)',jsonb_build_object(
    'organization_id',v_target_org,'plate_number','F148-FOREIGN-TYPE','vehicle_type_id',v_other_type,'branch_id',v_target_branch)),
    '42501',format('create_vehicle_v1: vehicle_type %s belongs to another organization',v_other_type),
    'platform creation cannot use a type owned by another organization');

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT api.create_vehicle_v1(
          jsonb_build_object(
            'organization_id', %L,
            'plate_number', 'PGTAP-BRANCH-DENIED',
            'vehicle_type_id', %L,
            'branch_id', %L,
            'status', 'active'
          )
        )
      $sql$,
      v_target_org::TEXT,
      v_target_type::TEXT,
      v_other_branch::TEXT
    ),
    '42501',
    NULL,
    'platform vehicle creation rejects branch rows outside the selected tenant'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_tenant_user,
      'role', 'authenticated',
      'email', 'console-vehicle-tenant@example.test'
    )::TEXT,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT api.create_vehicle_v1(
          jsonb_build_object(
            'organization_id', %L,
            'plate_number', 'PGTAP-TENANT-DENIED',
            'vehicle_type_id', %L,
            'branch_id', %L,
            'status', 'active'
          )
        )
      $sql$,
      v_target_org::TEXT,
      v_target_type::TEXT,
      v_target_branch::TEXT
    ),
    '42501',
    NULL,
    'non-platform tenant user cannot create vehicle outside their own tenant'
  );

  RETURN NEXT ok(COALESCE((public.user_capability_eval_v1('fleet.read')->>'allowed')::boolean,false),
    'default tenant ops_admin inherits canonical fleet.read without a fixture policy grant');
  RETURN NEXT ok(COALESCE((public.user_capability_eval_v1('fleet.write')->>'allowed')::boolean,false),
    'default tenant ops_admin inherits canonical fleet.write without a fixture policy grant');
  v_rows:=api.ui_list_resource_v1('vehicle_create_type_directory',jsonb_build_object('organization_id',v_other_org,'is_active',true),100,0,NULL);
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows->'items') e WHERE e->>'id'=v_other_type::text),
    'tenant picker positively exposes its own active vehicle type');
  v_rows:=api.ui_list_resource_v1('vehicle_create_branch_directory',jsonb_build_object('organization_id',v_other_org),100,0,NULL);
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows->'items') e WHERE e->>'id'=v_other_branch::text),
    'tenant picker positively exposes its own branch');
  v_rows:=api.ui_list_resource_v1('vehicle_create_type_directory',jsonb_build_object('organization_id',v_target_org,'is_active',true),100,0,NULL);
  RETURN NEXT is(jsonb_array_length(v_rows->'items'),0,'tenant cannot select foreign types through an explicit organization filter');
  v_rows:=api.ui_list_resource_v1('vehicle_create_branch_directory',jsonb_build_object('organization_id',v_target_org),100,0,NULL);
  RETURN NEXT is(jsonb_array_length(v_rows->'items'),0,'tenant cannot select foreign branches through an explicit organization filter');
  v_rows:=api.ui_list_resource_v1('vehicle_create_form_schema',jsonb_build_object('is_active',true),100,0,NULL);
  RETURN NEXT ok(jsonb_array_length(v_rows->'items')=1,'tenant fleet reader positively receives the same global form schema');
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT sv.value,sv.schema_version INTO STRICT v_policy,v_policy_version FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='access_control_policy' AND s.scope_type='global' AND s.scope_id IS NULL;
  v_policy:=jsonb_set(v_policy,'{denies}',COALESCE(v_policy->'denies','[]'::jsonb)||'[{"capability_key":"fleet.read"}]'::jsonb);
  PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',v_other_org,v_policy,v_policy_version,'Owned F148 schema permission denial');
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok($sql$SELECT api.ui_list_resource_v1('vehicle_create_form_schema','{}',100,0,NULL)$sql$,
    '42501','Capability denied: fleet.read','denied fleet reader cannot use the exact-schema registry resource');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_platform_create_vehicle_target_org();

SELECT * FROM finish();

ROLLBACK;
