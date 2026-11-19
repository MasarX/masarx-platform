-- Plan: PLAN-202604-b05-transfer-execution-surface / Step: S02
-- pgTAP: UC069 warehouse transfer reconcile UI contract v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

CREATE OR REPLACE FUNCTION pg_temp.test_warehouse_transfer_reconcile_ui_contract_v1()
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
    'ui_execute_warehouse_transfer_reconcile_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_warehouse_transfer_reconcile_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_warehouse_transfer_reconcile_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_warehouse_transfer_reconcile_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can EXECUTE public.ui_execute_warehouse_transfer_reconcile_v1'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'service_role',
      'public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'service_role can EXECUTE public.ui_execute_warehouse_transfer_reconcile_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege(
      'anon',
      'public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'anon cannot EXECUTE public.ui_execute_warehouse_transfer_reconcile_v1'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can EXECUTE api.ui_execute_warehouse_transfer_reconcile_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege(
      'anon',
      'api.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'anon cannot EXECUTE api.ui_execute_warehouse_transfer_reconcile_v1'
  );
  RETURN NEXT ok(
    position(
      '''role'', ''service_role'''
      IN pg_get_functiondef('public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    ) > 0,
    'public.ui_execute_warehouse_transfer_reconcile_v1 wakes service-only workflow transitions with a guarded service claim'
  );
  RETURN NEXT ok(
    position(
      'progress_workflow_run_until_wait_v1'
      IN pg_get_functiondef('public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    ) > 0,
    'public.ui_execute_warehouse_transfer_reconcile_v1 returns terminal workflow readback before Console refreshes the drawer'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_command_settings->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.reconcile_destination'
        AND item.value->>'schema_category' = 'resource:warehouse_transfers'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_warehouse_transfer_reconcile_v1'
        AND item.value#>>'{execution,type}' = 'workflow'
    ),
    'ui_command_registry cached settings expose warehouse_transfers.reconcile_destination through the dedicated workflow RPC'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Transfer Reconcile UI Org', 'transfer-reconcile-ui-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'transfer-reconcile-ui-' || left(v_user::text, 8) || '@example.com',
    'Transfer Reconcile UI User',
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
      WHERE item.value->>'key' = 'warehouse_transfers.reconcile_destination'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_warehouse_transfer_reconcile_v1'
    ),
    'ui_command_registry_v1 returns warehouse_transfers.reconcile_destination to an authenticated tenant user'
  );
  RETURN NEXT ok(
    jsonb_typeof(COALESCE(public.ui_command_registry_v1()->'commands', '[]'::jsonb)) = 'array',
    'ui_command_registry_v1 remains callable after the transfer reconcile command was added'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_warehouse_transfer_reconcile_ui_contract_v1();

SELECT * FROM finish();

ROLLBACK;
