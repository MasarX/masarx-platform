-- Plan: PLAN-202604-b05-transfer-execution-surface / Step: S02
-- pgTAP: UC068 warehouse transfer checkpoint UI contract v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(15);

CREATE OR REPLACE FUNCTION pg_temp.test_warehouse_transfer_checkpoint_ui_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_command_settings JSONB := NULL;
  v_user UUID := gen_random_uuid();
  v_org UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_command_settings
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function(
    'public',
    'ui_execute_warehouse_transfer_checkpoint_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_warehouse_transfer_checkpoint_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_warehouse_transfer_checkpoint_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_warehouse_transfer_checkpoint_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'public.ui_execute_warehouse_transfer_checkpoint_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can EXECUTE public.ui_execute_warehouse_transfer_checkpoint_v1'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'service_role',
      'public.ui_execute_warehouse_transfer_checkpoint_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'service_role can EXECUTE public.ui_execute_warehouse_transfer_checkpoint_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege(
      'anon',
      'public.ui_execute_warehouse_transfer_checkpoint_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'anon cannot EXECUTE public.ui_execute_warehouse_transfer_checkpoint_v1'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_warehouse_transfer_checkpoint_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can EXECUTE api.ui_execute_warehouse_transfer_checkpoint_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege(
      'anon',
      'api.ui_execute_warehouse_transfer_checkpoint_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'anon cannot EXECUTE api.ui_execute_warehouse_transfer_checkpoint_v1'
  );
  RETURN NEXT ok(
    position(
      'console-v2-browser-scanner'
      IN pg_get_functiondef('api.ui_execute_warehouse_transfer_checkpoint_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    ) > 0,
    'api.ui_execute_warehouse_transfer_checkpoint_v1 provisions the managed Console browser scanner device when device_id is omitted'
  );
  RETURN NEXT ok(
    position(
      'warehouse_transfer_sequence'
      IN pg_get_functiondef('public.record_scan_event_v1(jsonb)'::regprocedure)
    ) > 0,
    'record_scan_event_v1 resolves transfer-scoped warehouse checkpoint sequence from scan_policy'
  );
  RETURN NEXT ok(
    position(
      '''role'', ''service_role'''
      IN pg_get_functiondef('public.ui_execute_warehouse_transfer_checkpoint_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    ) > 0,
    'public.ui_execute_warehouse_transfer_checkpoint_v1 wakes service-only workflow transitions with a guarded service claim'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_command_settings->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.scan_departure'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_warehouse_transfer_checkpoint_v1'
        AND item.value#>>'{execution,input_schema,fields,0,key}' = 'barcode'
    ),
    'ui_command_registry cached settings expose warehouse_transfers.scan_departure through the dedicated checkpoint RPC'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_command_settings->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.scan_arrival'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_warehouse_transfer_checkpoint_v1'
        AND item.value#>>'{execution,input_schema,fields,0,key}' = 'barcode'
    ),
    'ui_command_registry cached settings expose warehouse_transfers.scan_arrival through the dedicated checkpoint RPC'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Transfer Checkpoint UI Org', 'transfer-checkpoint-ui-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'transfer-checkpoint-ui-' || left(v_user::text, 8) || '@example.com',
    'Transfer Checkpoint UI User',
    'ops_admin',
    'tenant'
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'role', 'authenticated',
      'sub', v_user::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(public.ui_command_registry_v1()->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.scan_departure'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_warehouse_transfer_checkpoint_v1'
    ),
    'ui_command_registry_v1 returns warehouse_transfers.scan_departure to an authenticated tenant user'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(public.ui_command_registry_v1()->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.scan_arrival'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_warehouse_transfer_checkpoint_v1'
    ),
    'ui_command_registry_v1 returns warehouse_transfers.scan_arrival to an authenticated tenant user'
  );
  RETURN NEXT ok(
    public.ui_command_registry_v1() #>> '{commands,0,key}' IS NOT NULL,
    'ui_command_registry_v1 remains callable after the transfer checkpoint commands were added'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_warehouse_transfer_checkpoint_ui_contract_v1();

SELECT * FROM finish();

ROLLBACK;
