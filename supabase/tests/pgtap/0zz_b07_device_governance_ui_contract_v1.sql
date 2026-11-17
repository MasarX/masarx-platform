-- Plan: PLAN-202604-b07-device-governance-ui-contract / Step: S01
-- pgTAP: B07 device governance UI contract v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

CREATE OR REPLACE FUNCTION pg_temp.test_b07_device_governance_ui_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_access JSONB := NULL;
  v_registry JSONB := NULL;
  v_commands JSONB := NULL;
  v_navigation JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_owner UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_device RECORD;
  v_device_id UUID := NULL;
  v_list JSONB := NULL;
  v_detail JSONB := NULL;
  v_revoke_result JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_access
    FROM public.settings
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_navigation
    FROM public.settings
   WHERE category = 'ui_navigation'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function(
    'public',
    'ui_execute_user_device_revoke_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_user_device_revoke_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_user_device_revoke_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_user_device_revoke_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_user_device_revoke_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_execute_user_device_revoke_v1'
  );
  RETURN NEXT is(
    v_access#>>'{resource_map,user_devices,read}',
    'user_devices.read',
    'resource_map wires user_devices.read'
  );
  RETURN NEXT is(
    v_access#>>'{resource_map,user_devices,write}',
    'user_devices.write',
    'resource_map wires user_devices.write'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'user_devices'
        AND item.value->>'relation' = 'public.user_devices'
        AND item.value->>'capability_read' = 'user_devices.read'
    ),
    'ui_read_registry exposes user_devices against public.user_devices'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'user_devices.revoke'
        AND item.value#>>'{execution,type}' = 'rpc'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_user_device_revoke_v1'
    ),
    'ui_command_registry exposes the user_devices.revoke RPC'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'user_devices'
    ),
    'console operations navigation includes user_devices'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,portal,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'user_devices'
    ),
    'portal operations navigation includes user_devices'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Device Governance UI Org', 'device-governance-ui-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_owner, v_org, 'device-owner-' || left(v_owner::text, 8) || '@example.com', 'Device Owner', 'driver', 'tenant'),
    (v_operator, v_org, 'ops-admin-' || left(v_operator::text, 8) || '@example.com', 'Ops Admin', 'ops_admin', 'tenant');

  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_device
    FROM public.register_user_device_v1(
      jsonb_build_object(
        'device_platform', 'android',
        'device_identifier_sha256', 'b07-device-governance-ui-device-1',
        'device_label', 'Route phone',
        'app_version', '1.0.0',
        'os_version', '14',
        'push_token', 'ui-push-token-1'
      )
    )
    LIMIT 1;

  v_device_id := v_device.device_id;

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(public.ui_read_registry_v1()->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'user_devices'
    ),
    'ui_read_registry_v1 returns user_devices to tenant ops admins'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(public.ui_navigation_v1('console')#>'{sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'user_devices'
    ),
    'ui_navigation_v1(console) returns user_devices to tenant ops admins'
  );

  v_list := public.ui_list_resource_v1(
    'user_devices',
    jsonb_build_object('user_id', v_owner::text),
    25,
    0
  );

  RETURN NEXT is(v_list->>'resource', 'user_devices', 'ui_list_resource_v1 returns the user_devices resource key');
  RETURN NEXT is((v_list->>'total')::int, 1, 'ui_list_resource_v1 exposes another user device inside the same organization');

  v_revoke_result := api.ui_execute_user_device_revoke_v1(
    'user_devices.revoke',
    'user_devices',
    ARRAY[v_device_id::text],
    v_device_id::text,
    1,
    '{}'::jsonb
  );

  RETURN NEXT is(v_revoke_result->>'status', 'revoked', 'api.ui_execute_user_device_revoke_v1 reports revoked status');

  v_detail := public.ui_get_resource_v1('user_devices', v_device_id);

  RETURN NEXT ok((v_detail->>'revoked_at') IS NOT NULL, 'ui_get_resource_v1 exposes revoked_at after operator revoke');
  RETURN NEXT is(
    v_detail->>'revoked_reason',
    'revoked by console or portal operator',
    'ui_get_resource_v1 keeps the operator revoke reason visible'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_b07_device_governance_ui_contract_v1();

SELECT * FROM finish();

ROLLBACK;
