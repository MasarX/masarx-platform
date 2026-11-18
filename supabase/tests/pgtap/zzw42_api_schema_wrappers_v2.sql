-- W42 closure of console-v2 100% production-readiness Wave 2.
-- pgTAP: api.* schema wrappers for the remaining 40 console-v2 RPCs.
--
-- Asserts (per wrapper):
--   * The api.<rpc_name> function exists with the expected signature.
--   * authenticated has EXECUTE.
--   * service_role has EXECUTE.
--   * SECURITY DEFINER posture is preserved (pg_proc.prosecdef = true).
--
-- Migration under test: supabase/migrations/202605020001_w42_api_schema_wrappers_v2.sql
-- Companion W41 coverage: zzw41_api_schema_wrappers.sql

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- Test count breakdown:
--   34 canonical wrappers × 4 assertions (exists, authenticated, service_role, secdef) = 136
--    6 non-canonical wrappers × 4 assertions                                          =  24
--   Total                                                                             = 160
SELECT plan(160);

-- ---------------------------------------------------------------------------
-- Canonical (p_args jsonb) RETURNS jsonb wrappers (34)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION test_w42_api_canonical_wrappers()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rpc TEXT;
  v_signature TEXT;
  v_proc_oid OID;
  v_rpcs TEXT[] := ARRAY[
    -- Group 1: customers + identity (5)
    'sender_create_v1',
    'sender_update_v1',
    'sender_suspend_v1',
    'sender_reactivate_v1',
    'recipient_update_v1',
    -- Group 2: RBAC (5)
    'rbac_create_role_v1',
    'rbac_update_role_v1',
    'rbac_delete_role_v1',
    'rbac_grant_role_v1',
    'rbac_revoke_role_v1',
    -- Group 3: zones (3)
    'zone_create_v1',
    'zone_district_add_v1',
    'zone_district_remove_v1',
    -- Group 4: branch ops (7)
    'mark_branch_oos_v1',
    'branch_zone_assign_v1',
    'branch_zone_unassign_v1',
    'add_branch_member_v1',
    'remove_branch_member_v1',
    'branch_capacity_window_set_v1',
    'branch_coverage_window_upsert_v1',
    -- Group 5: catalog (11)
    'lookup_definition_create_v1',
    'lookup_value_create_v1',
    'lookup_value_update_v1',
    'lookup_value_archive_v1',
    'lookup_value_promote_v1',
    'service_level_create_v1',
    'service_level_update_v1',
    'service_offering_create_v1',
    'service_offering_update_v1',
    'service_offering_toggle_v1',
    'service_offering_archive_v1',
    -- Group 6: platform/ops/finance (3)
    'revoke_session_v1',
    'test_integration_plugin_v1',
    'compute_bank_account_balance_v1'
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

    -- SECURITY DEFINER
    SELECT p.oid INTO v_proc_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'api' AND p.proname = v_rpc
    LIMIT 1;
    RETURN NEXT ok(
      (SELECT prosecdef FROM pg_proc WHERE oid = v_proc_oid),
      format('%s is SECURITY DEFINER', v_signature)
    );
  END LOOP;
END
$function$;

SELECT * FROM test_w42_api_canonical_wrappers();

-- ---------------------------------------------------------------------------
-- Non-canonical wrappers (6) — per-RPC explicit assertions
-- Each mirrors the underlying public.* signature verbatim.
-- ---------------------------------------------------------------------------

-- compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) RETURNS TABLE
SELECT has_function(
  'api', 'compute_kpi_rollup_v1', ARRAY['text', 'date', 'integer', 'uuid'],
  'api.compute_kpi_rollup_v1(text,date,int,uuid) wrapper exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.compute_kpi_rollup_v1(text,date,integer,uuid)', 'execute'),
  'authenticated has EXECUTE on api.compute_kpi_rollup_v1'
);
SELECT ok(
  has_function_privilege('service_role', 'api.compute_kpi_rollup_v1(text,date,integer,uuid)', 'execute'),
  'service_role has EXECUTE on api.compute_kpi_rollup_v1'
);
SELECT ok(
  (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='api' AND p.proname='compute_kpi_rollup_v1' LIMIT 1),
  'api.compute_kpi_rollup_v1 is SECURITY DEFINER'
);

-- resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN) RETURNS TABLE
SELECT has_function(
  'api', 'resolve_access_control_policy_v1', ARRAY['text', 'uuid', 'boolean'],
  'api.resolve_access_control_policy_v1(text,uuid,bool) wrapper exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_access_control_policy_v1(text,uuid,boolean)', 'execute'),
  'authenticated has EXECUTE on api.resolve_access_control_policy_v1'
);
SELECT ok(
  has_function_privilege('service_role', 'api.resolve_access_control_policy_v1(text,uuid,boolean)', 'execute'),
  'service_role has EXECUTE on api.resolve_access_control_policy_v1'
);
SELECT ok(
  (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='api' AND p.proname='resolve_access_control_policy_v1' LIMIT 1),
  'api.resolve_access_control_policy_v1 is SECURITY DEFINER'
);

-- resolve_ndr_branch_next_action_v1(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) RETURNS TEXT
SELECT has_function(
  'api', 'resolve_ndr_branch_next_action_v1',
  ARRAY['uuid','uuid','uuid','text','text','text','text','text','text','jsonb'],
  'api.resolve_ndr_branch_next_action_v1 wrapper exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_ndr_branch_next_action_v1(uuid,uuid,uuid,text,text,text,text,text,text,jsonb)', 'execute'),
  'authenticated has EXECUTE on api.resolve_ndr_branch_next_action_v1'
);
SELECT ok(
  has_function_privilege('service_role', 'api.resolve_ndr_branch_next_action_v1(uuid,uuid,uuid,text,text,text,text,text,text,jsonb)', 'execute'),
  'service_role has EXECUTE on api.resolve_ndr_branch_next_action_v1'
);
SELECT ok(
  (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='api' AND p.proname='resolve_ndr_branch_next_action_v1' LIMIT 1),
  'api.resolve_ndr_branch_next_action_v1 is SECURITY DEFINER'
);

-- transition_warehouse_transfer_v1(JSONB) RETURNS TABLE; underlying param is p_input
SELECT has_function(
  'api', 'transition_warehouse_transfer_v1', ARRAY['jsonb'],
  'api.transition_warehouse_transfer_v1(jsonb) wrapper exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.transition_warehouse_transfer_v1(jsonb)', 'execute'),
  'authenticated has EXECUTE on api.transition_warehouse_transfer_v1'
);
SELECT ok(
  has_function_privilege('service_role', 'api.transition_warehouse_transfer_v1(jsonb)', 'execute'),
  'service_role has EXECUTE on api.transition_warehouse_transfer_v1'
);
SELECT ok(
  (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='api' AND p.proname='transition_warehouse_transfer_v1' LIMIT 1),
  'api.transition_warehouse_transfer_v1 is SECURITY DEFINER'
);

-- ui_get_trace_v1(UUID) RETURNS jsonb
SELECT has_function(
  'api', 'ui_get_trace_v1', ARRAY['uuid'],
  'api.ui_get_trace_v1(uuid) wrapper exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.ui_get_trace_v1(uuid)', 'execute'),
  'authenticated has EXECUTE on api.ui_get_trace_v1'
);
SELECT ok(
  has_function_privilege('service_role', 'api.ui_get_trace_v1(uuid)', 'execute'),
  'service_role has EXECUTE on api.ui_get_trace_v1'
);
SELECT ok(
  (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='api' AND p.proname='ui_get_trace_v1' LIMIT 1),
  'api.ui_get_trace_v1 is SECURITY DEFINER'
);

-- user_capability_eval_v1(TEXT, TEXT, UUID) RETURNS jsonb
SELECT has_function(
  'api', 'user_capability_eval_v1', ARRAY['text', 'text', 'uuid'],
  'api.user_capability_eval_v1(text,text,uuid) wrapper exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.user_capability_eval_v1(text,text,uuid)', 'execute'),
  'authenticated has EXECUTE on api.user_capability_eval_v1'
);
SELECT ok(
  has_function_privilege('service_role', 'api.user_capability_eval_v1(text,text,uuid)', 'execute'),
  'service_role has EXECUTE on api.user_capability_eval_v1'
);
SELECT ok(
  (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='api' AND p.proname='user_capability_eval_v1' LIMIT 1),
  'api.user_capability_eval_v1 is SECURITY DEFINER'
);

ROLLBACK;
