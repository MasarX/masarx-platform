-- W44 — non-canonical RPC signature normalization (Wave 18 of console-v2 closure).
-- pgTAP: canonical (p_args jsonb) RETURNS jsonb sibling RPCs (`*_v2`) for the
--        6 RPCs that W42 had to wrap with their pre-canonical native
--        signatures.
--
-- Asserts (per *_v2 RPC, for both schemas — public + api):
--   1. The function exists with signature (jsonb).
--   2. service_role has EXECUTE.
--   3. authenticated has EXECUTE *or* explicitly does NOT have EXECUTE for
--      transition_warehouse_transfer_v2, which inherits the underlying
--      public.transition_warehouse_transfer_v1 service-role-only posture.
--   4. SECURITY DEFINER posture is preserved (pg_proc.prosecdef = true).
--   5. (transition_warehouse_transfer_v2 only) RETURNS jsonb confirmed via
--      pg_proc.prorettype.
--
-- Test count breakdown:
--   * Group A: 5 RPCs × 2 schemas × 4 assertions = 40
--   * Group B (transition_warehouse_transfer_v2): 2 schemas × 5 assertions = 10
--   Total: 50 assertions.
--
-- Migration under test: supabase/migrations/202605020200_w44_rpc_v2_normalizations.sql

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(50);

-- ---------------------------------------------------------------------------
-- Group A: 5 *_v2 RPCs with the standard authenticated + service_role grant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION test_w44_rpc_v2_standard_grants()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rpc        TEXT;
  v_schema     TEXT;
  v_signature  TEXT;
  v_proc_oid   OID;
  v_rpcs       TEXT[] := ARRAY[
    'compute_kpi_rollup_v2',
    'resolve_access_control_policy_v2',
    'resolve_ndr_branch_next_action_v2',
    'ui_get_trace_v2',
    'user_capability_eval_v2'
  ];
  v_schemas    TEXT[] := ARRAY['public', 'api'];
BEGIN
  FOREACH v_rpc IN ARRAY v_rpcs LOOP
    FOREACH v_schema IN ARRAY v_schemas LOOP
      v_signature := format('%I.%I(jsonb)', v_schema, v_rpc);

      RETURN NEXT has_function(
        v_schema, v_rpc, ARRAY['jsonb'],
        format('%s.%s(jsonb) wrapper exists', v_schema, v_rpc)
      );

      RETURN NEXT ok(
        has_function_privilege('authenticated', v_signature, 'execute'),
        format('authenticated has EXECUTE on %s', v_signature)
      );

      RETURN NEXT ok(
        has_function_privilege('service_role', v_signature, 'execute'),
        format('service_role has EXECUTE on %s', v_signature)
      );

      SELECT p.oid INTO v_proc_oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = v_schema AND p.proname = v_rpc
      LIMIT 1;

      RETURN NEXT ok(
        (SELECT prosecdef FROM pg_proc WHERE oid = v_proc_oid),
        format('%s is SECURITY DEFINER', v_signature)
      );
    END LOOP;
  END LOOP;
END
$function$;

SELECT * FROM test_w44_rpc_v2_standard_grants();

-- ---------------------------------------------------------------------------
-- Group B: transition_warehouse_transfer_v2 inherits *_v1 service-role-only
-- posture. authenticated must NOT have EXECUTE; service_role MUST have EXECUTE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION test_w44_transition_warehouse_transfer_v2()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_schema     TEXT;
  v_signature  TEXT;
  v_proc_oid   OID;
  v_schemas    TEXT[] := ARRAY['public', 'api'];
BEGIN
  FOREACH v_schema IN ARRAY v_schemas LOOP
    v_signature := format('%I.transition_warehouse_transfer_v2(jsonb)', v_schema);

    -- Existence
    RETURN NEXT has_function(
      v_schema, 'transition_warehouse_transfer_v2', ARRAY['jsonb'],
      format('%s.transition_warehouse_transfer_v2(jsonb) wrapper exists', v_schema)
    );

    -- service_role MUST have EXECUTE
    RETURN NEXT ok(
      has_function_privilege('service_role', v_signature, 'execute'),
      format('service_role has EXECUTE on %s', v_signature)
    );

    -- authenticated MUST NOT have EXECUTE (mirrors underlying *_v1 posture)
    RETURN NEXT ok(
      NOT has_function_privilege('authenticated', v_signature, 'execute'),
      format('authenticated does NOT have EXECUTE on %s (service_role-only mirror of _v1)', v_signature)
    );

    -- SECURITY DEFINER
    SELECT p.oid INTO v_proc_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = v_schema AND p.proname = 'transition_warehouse_transfer_v2'
    LIMIT 1;

    RETURN NEXT ok(
      (SELECT prosecdef FROM pg_proc WHERE oid = v_proc_oid),
      format('%s is SECURITY DEFINER', v_signature)
    );

    -- jsonb return type
    RETURN NEXT is(
      (SELECT pg_catalog.format_type(p.prorettype, NULL)
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = v_schema AND p.proname = 'transition_warehouse_transfer_v2'
        LIMIT 1),
      'jsonb',
      format('%s returns jsonb (canonical envelope contract)', v_signature)
    );
  END LOOP;
END
$function$;

SELECT * FROM test_w44_transition_warehouse_transfer_v2();

ROLLBACK;
