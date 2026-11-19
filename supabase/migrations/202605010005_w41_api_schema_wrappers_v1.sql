-- Spec-Issue: W41 closure of W40 local-Supabase E2E findings (F5)
-- Step: W41-F5
-- Migration: api.* schema wrappers for canonical lifecycle RPCs.
--
-- W40 finding (P0 for cutover):
--   docs/ops/evidence/2026-04-30/local-verify/lifecycle-rpc-smoke.log
--     Phase 02-12: HTTP 404 PGRST202
--       "Could not find the function api.<rpc_name>(p_args) in the schema cache"
--   PostgREST is configured to expose only `schemas = ["api"]`
--   (supabase/config.toml). The canonical lifecycle RPCs live under public.*
--   only, so live console-v2 calling client.rpc('client_create_v1', ...)
--   gets 404 PGRST202.
--
-- Closure:
--   Declare 18 thin api.* wrapper functions that delegate to the canonical
--   public.* RPC. Each wrapper:
--     * mirrors the underlying signature exactly,
--     * runs SECURITY DEFINER so the wrapper can be invoked by authenticated
--       sessions while delegating capability/RLS gates to the underlying
--       SECURITY DEFINER function (which uses auth.uid()/session GUCs),
--     * has its search_path pinned to public, extensions, pg_temp,
--     * grants EXECUTE only to authenticated + service_role (revoke PUBLIC).
--
--   17 of 18 use the canonical (p_args jsonb) RETURNS jsonb signature.
--   assign_pickup_wave_v1 declared (p_input JSONB) RETURNS JSONB in
--   202603191130_pickup_batch2_foundation_v1; the wrapper preserves that
--   exact parameter name to keep the PostgREST RPC named-arg path stable.
--
-- Append-only: this migration creates new objects only.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605010005_w41_api_schema_wrappers_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;

GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-- ===========================================================================
-- Group 1: client lifecycle (4 RPCs) -- Phase B / Network onboarding
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.client_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.client_create_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.client_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.client_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.client_create_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.client_create_v1; SECURITY DEFINER (delegates capability/RLS gates to the underlying RPC via auth.uid()/session GUCs).';

CREATE OR REPLACE FUNCTION api.client_suspend_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.client_suspend_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.client_suspend_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.client_suspend_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.client_suspend_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.client_suspend_v1.';

CREATE OR REPLACE FUNCTION api.client_reactivate_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.client_reactivate_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.client_reactivate_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.client_reactivate_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.client_reactivate_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.client_reactivate_v1.';

CREATE OR REPLACE FUNCTION api.client_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.client_update_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.client_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.client_update_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.client_update_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.client_update_v1.';

-- ===========================================================================
-- Group 2: user lifecycle (3 RPCs) -- Phase B / Identity
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.grant_user_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.grant_user_role_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.grant_user_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.grant_user_role_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.grant_user_role_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.grant_user_role_v1.';

CREATE OR REPLACE FUNCTION api.suspend_user_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.suspend_user_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.suspend_user_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.suspend_user_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.suspend_user_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.suspend_user_v1.';

CREATE OR REPLACE FUNCTION api.reactivate_user_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.reactivate_user_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.reactivate_user_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.reactivate_user_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.reactivate_user_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.reactivate_user_v1.';

-- ===========================================================================
-- Group 3: branch lifecycle (2 RPCs) -- Phase B / Network onboarding
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.branch_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.branch_create_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.branch_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.branch_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.branch_create_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.branch_create_v1.';

CREATE OR REPLACE FUNCTION api.branch_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.branch_update_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.branch_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.branch_update_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.branch_update_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.branch_update_v1.';

-- ===========================================================================
-- Group 4: fleet lifecycle (5 RPCs) -- Phase B / Fleet
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.assign_driver_to_vehicle_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.assign_driver_to_vehicle_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.assign_driver_to_vehicle_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.assign_driver_to_vehicle_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.assign_driver_to_vehicle_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.assign_driver_to_vehicle_v1.';

CREATE OR REPLACE FUNCTION api.unassign_driver_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.unassign_driver_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.unassign_driver_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.unassign_driver_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.unassign_driver_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.unassign_driver_v1.';

CREATE OR REPLACE FUNCTION api.mark_vehicle_oos_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.mark_vehicle_oos_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.mark_vehicle_oos_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.mark_vehicle_oos_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.mark_vehicle_oos_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.mark_vehicle_oos_v1.';

CREATE OR REPLACE FUNCTION api.restore_vehicle_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.restore_vehicle_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.restore_vehicle_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.restore_vehicle_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.restore_vehicle_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.restore_vehicle_v1.';

CREATE OR REPLACE FUNCTION api.schedule_maintenance_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.schedule_maintenance_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.schedule_maintenance_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.schedule_maintenance_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.schedule_maintenance_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.schedule_maintenance_v1.';

-- ===========================================================================
-- Group 5: alerts lifecycle (3 RPCs) -- Phase B / Alerts
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.create_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.create_alert_rule_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.create_alert_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.create_alert_rule_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.create_alert_rule_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.create_alert_rule_v1.';

CREATE OR REPLACE FUNCTION api.update_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.update_alert_rule_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.update_alert_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.update_alert_rule_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.update_alert_rule_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.update_alert_rule_v1.';

CREATE OR REPLACE FUNCTION api.delete_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.delete_alert_rule_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.delete_alert_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.delete_alert_rule_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.delete_alert_rule_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.delete_alert_rule_v1.';

-- ===========================================================================
-- Group 6: pickup wave assignment (1 RPC, distinct signature)
--   Underlying signature: public.assign_pickup_wave_v1(p_input JSONB)
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.assign_pickup_wave_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.assign_pickup_wave_v1(p_input);
$$;
REVOKE ALL ON FUNCTION api.assign_pickup_wave_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.assign_pickup_wave_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.assign_pickup_wave_v1(jsonb) IS
  'W41 F5 api wrapper exposing public.assign_pickup_wave_v1; underlying parameter name is p_input (kept stable for PostgREST named-arg dispatch).';

SELECT pg_advisory_unlock(hashtext('202605010005_w41_api_schema_wrappers_v1'));

COMMIT;
