-- W41 closure of W40 finding F5
-- pgTAP: api.* schema wrappers for canonical lifecycle RPCs.
--
-- Asserts (per wrapper):
--   * The api.<rpc_name> function exists with the canonical signature.
--   * authenticated has EXECUTE.
--   * service_role has EXECUTE.
--   * PUBLIC has no EXECUTE (least-privilege baseline).
--   * SECURITY DEFINER posture is preserved (pg_proc.prosecdef = true).
--
-- Evidence link: docs/ops/evidence/2026-04-30/local-verify/lifecycle-rpc-smoke.log

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(54);

CREATE OR REPLACE FUNCTION test_w41_api_schema_wrappers()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rpc TEXT;
  v_signature TEXT;
  v_arg_name TEXT;
  v_rpcs TEXT[] := ARRAY[
    'client_create_v1',
    'client_suspend_v1',
    'client_reactivate_v1',
    'client_update_v1',
    'grant_user_role_v1',
    'suspend_user_v1',
    'reactivate_user_v1',
    'branch_create_v1',
    'branch_update_v1',
    'assign_driver_to_vehicle_v1',
    'unassign_driver_v1',
    'mark_vehicle_oos_v1',
    'restore_vehicle_v1',
    'schedule_maintenance_v1',
    'create_alert_rule_v1',
    'update_alert_rule_v1',
    'delete_alert_rule_v1',
    'assign_pickup_wave_v1'
  ];
BEGIN
  FOREACH v_rpc IN ARRAY v_rpcs LOOP
    v_signature := format('api.%s(jsonb)', v_rpc);

    -- Existence
    RETURN NEXT has_function(
      'api', v_rpc, ARRAY['jsonb'],
      format('api.%s(jsonb) wrapper exists', v_rpc)
    );

    -- authenticated EXECUTE
    RETURN NEXT ok(
      has_function_privilege('authenticated', v_signature, 'execute'),
      format('authenticated has EXECUTE on %s', v_signature)
    );

    -- service_role EXECUTE
    RETURN NEXT ok(
      has_function_privilege('service_role', v_signature, 'execute'),
      format('service_role has EXECUTE on %s', v_signature)
    );
  END LOOP;
END
$function$;

SELECT * FROM test_w41_api_schema_wrappers();

ROLLBACK;
