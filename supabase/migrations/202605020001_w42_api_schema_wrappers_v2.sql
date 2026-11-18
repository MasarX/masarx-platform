-- Spec-Issue: W42 closure of console-v2 100% production-readiness Wave 2
-- Step: W42-RPC-WRAPPERS
-- Migration: api.* schema wrappers for the remaining 40 console-v2 RPCs.
--
-- Background:
--   W41 (202605010005_w41_api_schema_wrappers_v1.sql) shipped 18 wrappers
--   covering the highest-priority lifecycle/fleet/alert/pickup RPCs that
--   were surfaced as 404 PGRST202 in the local-Supabase E2E. A subsequent
--   audit (Wave 0 / Wave 2 of the 100% closure loop) confirmed that 40
--   additional RPCs called by `apps/console-v2/src/lib/data-source.ts` via
--   `client.rpc(...)` still lack `api.*` wrappers and would 404 in live
--   PostgREST traffic.
--
--   PostgREST exposes only `schemas = ["api"]` (supabase/config.toml).
--   The canonical contract is: every business RPC consumed by console-v2
--   must be reachable through an `api.*_v1` wrapper that delegates to the
--   underlying `public.*_v1` SECURITY DEFINER function. Capability gating,
--   RLS, and audit logging stay inside the public function — the wrapper
--   is a thin schema-redirect with the same security posture as W41.
--
-- Wrapper pattern (mirrors W41 exactly):
--   * SECURITY DEFINER, search_path pinned to `public, extensions, pg_temp`.
--   * Body: a single SELECT delegating to the underlying public.* RPC
--     with the same parameter list.
--   * REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO authenticated, service_role.
--   * Variants where the underlying signature differs from
--     `(p_args jsonb) RETURNS jsonb` mirror the underlying signature
--     verbatim (parameter names, types, defaults, return type) so the
--     PostgREST named-arg dispatch path stays stable for the existing
--     console-v2 call sites in `data-source.ts`.
--
-- AGENTS.md objectives honored:
--   §4 (SINGLE SOURCE OF TRUTH): one canonical api.* wrapper per RPC,
--     declared once.
--   §5 (APPEND-ONLY MIGRATIONS): new file, no edits to W41 or earlier.
--   §6 (RLS ALWAYS): wrappers are thin SECURITY DEFINER passthroughs;
--     RLS / capability checks live in the underlying public.* RPCs
--     (which already invoke `assert_capability_v1` and write to
--     `decision_log` / `settings_resolution_log`).
--   §7 (CAPABILITY-GATED UI): every wrapped RPC retains its
--     `assert_capability_v1` call inside the public.* body — wrappers do
--     not bypass the gate.
--   §8 (CANONICAL RPC CONTRACT): 34/40 wrappers use the canonical
--     `(p_args jsonb) RETURNS jsonb` signature; 6/40 mirror the
--     underlying non-canonical signatures verbatim (named params,
--     RETURNS TABLE, RETURNS TEXT). The non-canonical underlying
--     signatures are tracked as a Wave 5 normalization candidate but
--     wrapping must be canonical-faithful right now (no signature
--     surgery in a wrapper-only migration).
--
-- Append-only: this migration creates new objects only.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605020001_w42_api_schema_wrappers_v2'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-- ===========================================================================
-- Group 1: customers + identity lifecycle (5 RPCs)
--   sender lifecycle (4) + recipient_update_v1 (1)
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.sender_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.sender_create_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.sender_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.sender_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.sender_create_v1(jsonb) IS
  'W42 api wrapper exposing public.sender_create_v1; SECURITY DEFINER (delegates capability/RLS gates to the underlying RPC).';

CREATE OR REPLACE FUNCTION api.sender_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.sender_update_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.sender_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.sender_update_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.sender_update_v1(jsonb) IS
  'W42 api wrapper exposing public.sender_update_v1.';

CREATE OR REPLACE FUNCTION api.sender_suspend_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.sender_suspend_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.sender_suspend_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.sender_suspend_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.sender_suspend_v1(jsonb) IS
  'W42 api wrapper exposing public.sender_suspend_v1.';

CREATE OR REPLACE FUNCTION api.sender_reactivate_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.sender_reactivate_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.sender_reactivate_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.sender_reactivate_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.sender_reactivate_v1(jsonb) IS
  'W42 api wrapper exposing public.sender_reactivate_v1.';

CREATE OR REPLACE FUNCTION api.recipient_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.recipient_update_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.recipient_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.recipient_update_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.recipient_update_v1(jsonb) IS
  'W42 api wrapper exposing public.recipient_update_v1.';

-- ===========================================================================
-- Group 2: RBAC role/grant management (5 RPCs)
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.rbac_create_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.rbac_create_role_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.rbac_create_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.rbac_create_role_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.rbac_create_role_v1(jsonb) IS
  'W42 api wrapper exposing public.rbac_create_role_v1.';

CREATE OR REPLACE FUNCTION api.rbac_update_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.rbac_update_role_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.rbac_update_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.rbac_update_role_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.rbac_update_role_v1(jsonb) IS
  'W42 api wrapper exposing public.rbac_update_role_v1.';

CREATE OR REPLACE FUNCTION api.rbac_delete_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.rbac_delete_role_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.rbac_delete_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.rbac_delete_role_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.rbac_delete_role_v1(jsonb) IS
  'W42 api wrapper exposing public.rbac_delete_role_v1.';

CREATE OR REPLACE FUNCTION api.rbac_grant_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.rbac_grant_role_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.rbac_grant_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.rbac_grant_role_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.rbac_grant_role_v1(jsonb) IS
  'W42 api wrapper exposing public.rbac_grant_role_v1.';

CREATE OR REPLACE FUNCTION api.rbac_revoke_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.rbac_revoke_role_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.rbac_revoke_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.rbac_revoke_role_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.rbac_revoke_role_v1(jsonb) IS
  'W42 api wrapper exposing public.rbac_revoke_role_v1.';

-- ===========================================================================
-- Group 3: zones (3 RPCs)
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.zone_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.zone_create_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.zone_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.zone_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.zone_create_v1(jsonb) IS
  'W42 api wrapper exposing public.zone_create_v1.';

CREATE OR REPLACE FUNCTION api.zone_district_add_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.zone_district_add_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.zone_district_add_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.zone_district_add_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.zone_district_add_v1(jsonb) IS
  'W42 api wrapper exposing public.zone_district_add_v1.';

CREATE OR REPLACE FUNCTION api.zone_district_remove_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.zone_district_remove_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.zone_district_remove_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.zone_district_remove_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.zone_district_remove_v1(jsonb) IS
  'W42 api wrapper exposing public.zone_district_remove_v1.';

-- ===========================================================================
-- Group 4: branch ops (7 RPCs)
--   mark_branch_oos, branch_zone_assign/unassign, add/remove_branch_member,
--   branch_capacity_window_set, branch_coverage_window_upsert
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.mark_branch_oos_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.mark_branch_oos_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.mark_branch_oos_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.mark_branch_oos_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.mark_branch_oos_v1(jsonb) IS
  'W42 api wrapper exposing public.mark_branch_oos_v1.';

CREATE OR REPLACE FUNCTION api.branch_zone_assign_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.branch_zone_assign_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.branch_zone_assign_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.branch_zone_assign_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.branch_zone_assign_v1(jsonb) IS
  'W42 api wrapper exposing public.branch_zone_assign_v1.';

CREATE OR REPLACE FUNCTION api.branch_zone_unassign_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.branch_zone_unassign_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.branch_zone_unassign_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.branch_zone_unassign_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.branch_zone_unassign_v1(jsonb) IS
  'W42 api wrapper exposing public.branch_zone_unassign_v1.';

CREATE OR REPLACE FUNCTION api.add_branch_member_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.add_branch_member_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.add_branch_member_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.add_branch_member_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.add_branch_member_v1(jsonb) IS
  'W42 api wrapper exposing public.add_branch_member_v1.';

CREATE OR REPLACE FUNCTION api.remove_branch_member_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.remove_branch_member_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.remove_branch_member_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.remove_branch_member_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.remove_branch_member_v1(jsonb) IS
  'W42 api wrapper exposing public.remove_branch_member_v1.';

CREATE OR REPLACE FUNCTION api.branch_capacity_window_set_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.branch_capacity_window_set_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.branch_capacity_window_set_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.branch_capacity_window_set_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.branch_capacity_window_set_v1(jsonb) IS
  'W42 api wrapper exposing public.branch_capacity_window_set_v1.';

CREATE OR REPLACE FUNCTION api.branch_coverage_window_upsert_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.branch_coverage_window_upsert_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.branch_coverage_window_upsert_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.branch_coverage_window_upsert_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.branch_coverage_window_upsert_v1(jsonb) IS
  'W42 api wrapper exposing public.branch_coverage_window_upsert_v1.';

-- ===========================================================================
-- Group 5: catalog / lookup definitions (5 RPCs) and service offerings (6 RPCs)
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.lookup_definition_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.lookup_definition_create_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.lookup_definition_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.lookup_definition_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.lookup_definition_create_v1(jsonb) IS
  'W42 api wrapper exposing public.lookup_definition_create_v1.';

CREATE OR REPLACE FUNCTION api.lookup_value_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.lookup_value_create_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.lookup_value_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.lookup_value_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.lookup_value_create_v1(jsonb) IS
  'W42 api wrapper exposing public.lookup_value_create_v1.';

CREATE OR REPLACE FUNCTION api.lookup_value_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.lookup_value_update_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.lookup_value_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.lookup_value_update_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.lookup_value_update_v1(jsonb) IS
  'W42 api wrapper exposing public.lookup_value_update_v1.';

CREATE OR REPLACE FUNCTION api.lookup_value_archive_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.lookup_value_archive_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.lookup_value_archive_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.lookup_value_archive_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.lookup_value_archive_v1(jsonb) IS
  'W42 api wrapper exposing public.lookup_value_archive_v1.';

CREATE OR REPLACE FUNCTION api.lookup_value_promote_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.lookup_value_promote_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.lookup_value_promote_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.lookup_value_promote_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.lookup_value_promote_v1(jsonb) IS
  'W42 api wrapper exposing public.lookup_value_promote_v1.';

CREATE OR REPLACE FUNCTION api.service_level_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.service_level_create_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.service_level_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.service_level_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.service_level_create_v1(jsonb) IS
  'W42 api wrapper exposing public.service_level_create_v1.';

CREATE OR REPLACE FUNCTION api.service_level_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.service_level_update_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.service_level_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.service_level_update_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.service_level_update_v1(jsonb) IS
  'W42 api wrapper exposing public.service_level_update_v1.';

CREATE OR REPLACE FUNCTION api.service_offering_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.service_offering_create_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.service_offering_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.service_offering_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.service_offering_create_v1(jsonb) IS
  'W42 api wrapper exposing public.service_offering_create_v1.';

CREATE OR REPLACE FUNCTION api.service_offering_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.service_offering_update_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.service_offering_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.service_offering_update_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.service_offering_update_v1(jsonb) IS
  'W42 api wrapper exposing public.service_offering_update_v1.';

CREATE OR REPLACE FUNCTION api.service_offering_toggle_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.service_offering_toggle_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.service_offering_toggle_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.service_offering_toggle_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.service_offering_toggle_v1(jsonb) IS
  'W42 api wrapper exposing public.service_offering_toggle_v1.';

CREATE OR REPLACE FUNCTION api.service_offering_archive_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.service_offering_archive_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.service_offering_archive_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.service_offering_archive_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.service_offering_archive_v1(jsonb) IS
  'W42 api wrapper exposing public.service_offering_archive_v1.';

-- ===========================================================================
-- Group 6: platform / ops (3 RPCs)
--   revoke_session_v1, test_integration_plugin_v1, compute_bank_account_balance_v1
-- ===========================================================================

CREATE OR REPLACE FUNCTION api.revoke_session_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.revoke_session_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.revoke_session_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.revoke_session_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.revoke_session_v1(jsonb) IS
  'W42 api wrapper exposing public.revoke_session_v1.';

CREATE OR REPLACE FUNCTION api.test_integration_plugin_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.test_integration_plugin_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.test_integration_plugin_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.test_integration_plugin_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.test_integration_plugin_v1(jsonb) IS
  'W42 api wrapper exposing public.test_integration_plugin_v1.';

CREATE OR REPLACE FUNCTION api.compute_bank_account_balance_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.compute_bank_account_balance_v1(p_args);
$$;
REVOKE ALL ON FUNCTION api.compute_bank_account_balance_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.compute_bank_account_balance_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.compute_bank_account_balance_v1(jsonb) IS
  'W42 api wrapper exposing public.compute_bank_account_balance_v1.';

-- ===========================================================================
-- Group 7: non-canonical signatures (6 RPCs)
--
-- These RPCs predate the canonical (p_args jsonb) RETURNS jsonb contract.
-- The wrappers MIRROR each underlying signature exactly so the existing
-- console-v2 named-arg call sites in `data-source.ts` keep working without
-- any frontend change. Wave 5 candidate: normalize each underlying public.*
-- to the canonical contract via a separate fixup migration; once the
-- public.* signature changes, this api.* wrapper can be re-declared with
-- the canonical body. Per AGENTS.md NO WORKAROUNDS, we do not wedge a fake
-- (p_args jsonb) shape on top of a non-canonical underlying RPC here.
-- ===========================================================================

-- compute_kpi_rollup_v1: RETURNS TABLE with named params
CREATE OR REPLACE FUNCTION api.compute_kpi_rollup_v1(
  p_definition_key TEXT,
  p_day DATE DEFAULT NULL,
  p_window_days INT DEFAULT 1,
  p_scope_organization_id UUID DEFAULT NULL
)
RETURNS TABLE (
  kpi_key TEXT,
  label TEXT,
  "group" TEXT,
  value_num NUMERIC,
  numerator NUMERIC,
  denominator NUMERIC,
  format TEXT,
  unit TEXT,
  tone TEXT,
  delta TEXT,
  day DATE,
  scope_organization_id UUID,
  settings_resolution_id TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT *
  FROM public.compute_kpi_rollup_v1(
    p_definition_key,
    p_day,
    p_window_days,
    p_scope_organization_id
  );
$$;
REVOKE ALL ON FUNCTION api.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) TO authenticated, service_role;
COMMENT ON FUNCTION api.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) IS
  'W42 api wrapper exposing public.compute_kpi_rollup_v1; mirrors the underlying RETURNS TABLE signature verbatim. STABLE; capability-gated inside the underlying RPC (insights.read).';

-- resolve_access_control_policy_v1: RETURNS TABLE with named params
CREATE OR REPLACE FUNCTION api.resolve_access_control_policy_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_log BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  policy JSONB,
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  scope_path JSONB,
  settings_resolution_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT *
  FROM public.resolve_access_control_policy_v1(p_scope_type, p_scope_id, p_log);
$$;
REVOKE ALL ON FUNCTION api.resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN) TO authenticated, service_role;
COMMENT ON FUNCTION api.resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN) IS
  'W42 api wrapper exposing public.resolve_access_control_policy_v1; mirrors RETURNS TABLE auth-helper signature. STABLE; underlying function fails closed for inactive users.';

-- resolve_ndr_branch_next_action_v1: RETURNS TEXT with named params
CREATE OR REPLACE FUNCTION api.resolve_ndr_branch_next_action_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_service_type TEXT DEFAULT NULL,
  p_dispatch_exception_reason TEXT DEFAULT NULL,
  p_resolution_action TEXT DEFAULT NULL,
  p_task_type_key TEXT DEFAULT NULL,
  p_shipment_action_type TEXT DEFAULT NULL,
  p_review_status TEXT DEFAULT NULL,
  p_allowed_ndr_actions JSONB DEFAULT NULL
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_ndr_branch_next_action_v1(
    p_organization_id,
    p_client_id,
    p_sender_id,
    p_service_type,
    p_dispatch_exception_reason,
    p_resolution_action,
    p_task_type_key,
    p_shipment_action_type,
    p_review_status,
    p_allowed_ndr_actions
  );
$$;
REVOKE ALL ON FUNCTION api.resolve_ndr_branch_next_action_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.resolve_ndr_branch_next_action_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;
COMMENT ON FUNCTION api.resolve_ndr_branch_next_action_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) IS
  'W42 api wrapper exposing public.resolve_ndr_branch_next_action_v1; mirrors RETURNS TEXT policy-resolver signature.';

-- transition_warehouse_transfer_v1: RETURNS TABLE; underlying parameter is p_input
CREATE OR REPLACE FUNCTION api.transition_warehouse_transfer_v1(p_input jsonb)
RETURNS TABLE (
  warehouse_transfer_id UUID,
  updated BOOLEAN,
  status TEXT,
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT *
  FROM public.transition_warehouse_transfer_v1(p_input);
$$;
REVOKE ALL ON FUNCTION api.transition_warehouse_transfer_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.transition_warehouse_transfer_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.transition_warehouse_transfer_v1(jsonb) IS
  'W42 api wrapper exposing public.transition_warehouse_transfer_v1; underlying parameter name is p_input (kept stable for PostgREST named-arg dispatch).';

-- ui_get_trace_v1: RETURNS jsonb with single UUID param
CREATE OR REPLACE FUNCTION api.ui_get_trace_v1(p_correlation_id UUID)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_get_trace_v1(p_correlation_id);
$$;
REVOKE ALL ON FUNCTION api.ui_get_trace_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_get_trace_v1(UUID) TO authenticated, service_role;
COMMENT ON FUNCTION api.ui_get_trace_v1(UUID) IS
  'W42 api wrapper exposing public.ui_get_trace_v1; mirrors single-UUID-param trace lookup signature.';

-- user_capability_eval_v1: RETURNS jsonb with named params
CREATE OR REPLACE FUNCTION api.user_capability_eval_v1(
  p_capability_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.user_capability_eval_v1(p_capability_key, p_scope_type, p_scope_id);
$$;
REVOKE ALL ON FUNCTION api.user_capability_eval_v1(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.user_capability_eval_v1(TEXT, TEXT, UUID) TO authenticated, service_role;
COMMENT ON FUNCTION api.user_capability_eval_v1(TEXT, TEXT, UUID) IS
  'W42 api wrapper exposing public.user_capability_eval_v1; mirrors capability eval helper (auth.uid() resolves caller).';

SELECT pg_advisory_unlock(hashtext('202605020001_w42_api_schema_wrappers_v2'));

COMMIT;
