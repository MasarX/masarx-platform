-- Spec-Issue: W44 — non-canonical RPC signature normalization (Wave 18 of console-v2 closure)
-- Step: W44-RPC-V2
-- Migration: canonical (p_args jsonb) RETURNS jsonb sibling RPCs (`*_v2`) for
--            the 6 RPCs that W42 had to wrap with their pre-canonical native
--            signatures (group 7 of 202605020001_w42_api_schema_wrappers_v2.sql).
--
-- Background:
--   W42 declared `api.*` wrappers for 40 RPCs. 34 used the canonical
--   `(p_args jsonb) RETURNS jsonb` shape; 6 had to mirror the underlying
--   non-canonical native signatures verbatim (RETURNS TABLE / RETURNS TEXT /
--   single named-arg) so PostgREST named-arg dispatch from console-v2's
--   existing `client.rpc(...)` call sites kept working without a frontend
--   surgery in a wrapper-only migration.
--
--   The 6 outstanding RPCs at the start of W44 were:
--     1. compute_kpi_rollup_v1            (TEXT, DATE, INT, UUID) RETURNS TABLE
--     2. resolve_access_control_policy_v1 (TEXT, UUID, BOOLEAN) RETURNS TABLE
--     3. resolve_ndr_branch_next_action_v1 (UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) RETURNS TEXT
--     4. transition_warehouse_transfer_v1 (JSONB) RETURNS TABLE
--     5. ui_get_trace_v1                  (UUID) RETURNS jsonb
--     6. user_capability_eval_v1          (TEXT, TEXT, UUID) RETURNS jsonb
--
--   This migration ships canonical `*_v2(p_args jsonb) RETURNS jsonb` siblings
--   for each one and paired `api.*_v2(jsonb)` wrappers. The frontend
--   `apps/console-v2/src/lib/data-source.ts` cuts over to the *_v2 RPCs in the
--   companion patch; the *_v1 functions and `api.*_v1` wrappers remain in place
--   for back-compat consumers (server-side workflow callers,
--   `assert_capability_v1` -> `user_capability_eval_v1`,
--   `user_has_capability_v1` -> `resolve_access_control_policy_v1`,
--   warehouse-transfer workflow handlers, etc.) so this is a strictly additive,
--   zero-breaking-change migration.
--
-- Wrapper pattern (mirrors W41/W42 exactly):
--   public.<rpc>_v2(p_args jsonb) RETURNS jsonb
--     LANGUAGE plpgsql SECURITY DEFINER, search_path pinned, capability/RLS
--     gates retained inside the underlying *_v1 body which we delegate to.
--   api.<rpc>_v2(p_args jsonb) RETURNS jsonb
--     LANGUAGE sql SECURITY DEFINER, single-line passthrough.
--   REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO authenticated + service_role
--   for both schemas.
--
-- AGENTS.md objectives honored:
--   §1 SIMPLE/SCALABLE/DYNAMIC: each *_v2 is a thin envelope over the existing
--     *_v1 implementation; no business-logic duplication.
--   §2 ZERO REDUNDANCY/ZERO HARDCODING: all behavior continues to flow through
--     the underlying *_v1 functions; the *_v2 layer adds only the canonical
--     jsonb envelope shape.
--   §4 SINGLE SOURCE OF TRUTH: the underlying *_v1 implementation remains
--     authoritative; *_v2 is a pure projection.
--   §5 APPEND-ONLY MIGRATIONS: this migration creates new objects only; no
--     edits to W41/W42 or any earlier migration.
--   §6 RLS ALWAYS / SECURITY DEFINER: identical posture preserved by delegating
--     to the underlying SECURITY DEFINER *_v1 functions (their `assert_capability_v1`,
--     `auth.uid()`, and tenant scope guards stay intact).
--   §7 CAPABILITY-GATED UI: the gate lives inside *_v1 and is therefore
--     preserved transparently.
--   §8 CANONICAL RPC CONTRACT: every new function is `(p_args jsonb) RETURNS jsonb`,
--     SECURITY DEFINER, exposed through `api.*` wrappers — exactly matching
--     the W42 canonical group.
--   §10 NO WORKAROUNDS: W42 explicitly flagged group 7 as "Wave 5 normalization
--     candidate"; W44 is that normalization, not a workaround.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605020200_w44_rpc_v2_normalizations'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-- ===========================================================================
-- 1) compute_kpi_rollup_v2
--
-- Underlying public.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) RETURNS TABLE
-- (kpi_key, label, group, value_num, numerator, denominator, format, unit,
--  tone, delta, day, scope_organization_id, settings_resolution_id).
--
-- Envelope: { ok: true, rows: [<row_jsonb>...] }.
-- Per AGENTS.md the underlying RPC is documented as "resolve a single KPI
-- rollup row" but its declared return type is TABLE; we faithfully aggregate
-- the result set into `rows[]` to preserve fidelity for any future caller.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.compute_kpi_rollup_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args            jsonb := COALESCE(p_args, '{}'::jsonb);
  v_definition_key  TEXT;
  v_day             DATE;
  v_window_days     INT;
  v_scope_org_id    UUID;
  v_rows            jsonb;
BEGIN
  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'compute_kpi_rollup_v2 expects a jsonb object payload' USING ERRCODE = '22023';
  END IF;

  v_definition_key := NULLIF(btrim(COALESCE(v_args->>'definition_key', '')), '');
  BEGIN
    v_day := NULLIF(btrim(COALESCE(v_args->>'day', '')), '')::date;
  EXCEPTION WHEN others THEN
    v_day := NULL;
  END;
  BEGIN
    v_window_days := NULLIF(btrim(COALESCE(v_args->>'window_days', '')), '')::int;
  EXCEPTION WHEN others THEN
    v_window_days := NULL;
  END;
  BEGIN
    v_scope_org_id := NULLIF(btrim(COALESCE(v_args->>'scope_organization_id', '')), '')::uuid;
  EXCEPTION WHEN others THEN
    v_scope_org_id := NULL;
  END;

  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.day NULLS LAST), '[]'::jsonb)
    INTO v_rows
    FROM public.compute_kpi_rollup_v1(
      v_definition_key,
      v_day,
      COALESCE(v_window_days, 1),
      v_scope_org_id
    ) AS r;

  RETURN jsonb_build_object(
    'ok', true,
    'rows', COALESCE(v_rows, '[]'::jsonb)
  );
END;
$function$;

COMMENT ON FUNCTION public.compute_kpi_rollup_v2(jsonb) IS
  'W44 canonical RPC contract normalization. Wraps public.compute_kpi_rollup_v1 with the canonical (p_args jsonb) RETURNS jsonb envelope { ok, rows[] }. Frontend cuts over to _v2; _v1 stays for any back-compat consumers.';

REVOKE ALL ON FUNCTION public.compute_kpi_rollup_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_kpi_rollup_v2(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.compute_kpi_rollup_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.compute_kpi_rollup_v2(p_args);
$$;
REVOKE ALL ON FUNCTION api.compute_kpi_rollup_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.compute_kpi_rollup_v2(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.compute_kpi_rollup_v2(jsonb) IS
  'W44 api wrapper exposing public.compute_kpi_rollup_v2 (canonical jsonb envelope sibling of public.compute_kpi_rollup_v1).';

-- ===========================================================================
-- 2) resolve_access_control_policy_v2
--
-- Underlying public.resolve_access_control_policy_v1(TEXT, UUID, BOOLEAN)
-- RETURNS TABLE (policy, settings_id, settings_version_id, scope_type,
-- scope_id, scope_path, settings_resolution_id).
--
-- Envelope: { ok: true, policy, settings_id, settings_version_id, scope_type,
-- scope_id, scope_path, settings_resolution_id } (single-object since the
-- underlying resolver returns 0..1 rows; absent rows surface as ok:true with
-- null fields so the canonical envelope contract stays stable).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_access_control_policy_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args        jsonb := COALESCE(p_args, '{}'::jsonb);
  v_scope_type  TEXT;
  v_scope_id    UUID;
  v_log         BOOLEAN;
  v_row         RECORD;
BEGIN
  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'resolve_access_control_policy_v2 expects a jsonb object payload' USING ERRCODE = '22023';
  END IF;

  v_scope_type := NULLIF(btrim(COALESCE(v_args->>'scope_type', '')), '');
  BEGIN
    v_scope_id := NULLIF(btrim(COALESCE(v_args->>'scope_id', '')), '')::uuid;
  EXCEPTION WHEN others THEN
    v_scope_id := NULL;
  END;
  BEGIN
    v_log := COALESCE((v_args->>'log')::boolean, FALSE);
  EXCEPTION WHEN others THEN
    v_log := FALSE;
  END;

  SELECT *
    INTO v_row
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_scope_id, v_log)
    LIMIT 1;

  RETURN jsonb_build_object(
    'ok', true,
    'policy', v_row.policy,
    'settings_id', v_row.settings_id,
    'settings_version_id', v_row.settings_version_id,
    'scope_type', v_row.scope_type,
    'scope_id', v_row.scope_id,
    'scope_path', v_row.scope_path,
    'settings_resolution_id', v_row.settings_resolution_id
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_access_control_policy_v2(jsonb) IS
  'W44 canonical RPC contract normalization. Wraps public.resolve_access_control_policy_v1 with the canonical (p_args jsonb) RETURNS jsonb envelope. Frontend cuts over to _v2; _v1 stays for any back-compat consumers (e.g. user_has_capability_v1, user_capability_eval_v1).';

REVOKE ALL ON FUNCTION public.resolve_access_control_policy_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_access_control_policy_v2(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_access_control_policy_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_access_control_policy_v2(p_args);
$$;
REVOKE ALL ON FUNCTION api.resolve_access_control_policy_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.resolve_access_control_policy_v2(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.resolve_access_control_policy_v2(jsonb) IS
  'W44 api wrapper exposing public.resolve_access_control_policy_v2 (canonical jsonb envelope sibling of public.resolve_access_control_policy_v1).';

-- ===========================================================================
-- 3) resolve_ndr_branch_next_action_v2
--
-- Underlying public.resolve_ndr_branch_next_action_v1
--   (UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) RETURNS TEXT.
--
-- Envelope: { ok: true, action: <text> }.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_ndr_branch_next_action_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args                       jsonb := COALESCE(p_args, '{}'::jsonb);
  v_organization_id            UUID;
  v_client_id                  UUID;
  v_sender_id                  UUID;
  v_service_type               TEXT;
  v_dispatch_exception_reason  TEXT;
  v_resolution_action          TEXT;
  v_task_type_key              TEXT;
  v_shipment_action_type       TEXT;
  v_review_status              TEXT;
  v_allowed_ndr_actions        JSONB;
  v_action                     TEXT;
BEGIN
  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'resolve_ndr_branch_next_action_v2 expects a jsonb object payload' USING ERRCODE = '22023';
  END IF;

  BEGIN v_organization_id := NULLIF(btrim(COALESCE(v_args->>'organization_id', '')), '')::uuid;
  EXCEPTION WHEN others THEN v_organization_id := NULL; END;
  BEGIN v_client_id := NULLIF(btrim(COALESCE(v_args->>'client_id', '')), '')::uuid;
  EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(btrim(COALESCE(v_args->>'sender_id', '')), '')::uuid;
  EXCEPTION WHEN others THEN v_sender_id := NULL; END;

  v_service_type              := NULLIF(btrim(COALESCE(v_args->>'service_type', '')), '');
  v_dispatch_exception_reason := NULLIF(btrim(COALESCE(v_args->>'dispatch_exception_reason', '')), '');
  v_resolution_action         := NULLIF(btrim(COALESCE(v_args->>'resolution_action', '')), '');
  v_task_type_key             := NULLIF(btrim(COALESCE(v_args->>'task_type_key', '')), '');
  v_shipment_action_type      := NULLIF(btrim(COALESCE(v_args->>'shipment_action_type', '')), '');
  v_review_status             := NULLIF(btrim(COALESCE(v_args->>'review_status', '')), '');

  v_allowed_ndr_actions := v_args->'allowed_ndr_actions';
  IF jsonb_typeof(v_allowed_ndr_actions) IS DISTINCT FROM 'array' THEN
    v_allowed_ndr_actions := NULL;
  END IF;

  v_action := public.resolve_ndr_branch_next_action_v1(
    v_organization_id,
    v_client_id,
    v_sender_id,
    v_service_type,
    v_dispatch_exception_reason,
    v_resolution_action,
    v_task_type_key,
    v_shipment_action_type,
    v_review_status,
    v_allowed_ndr_actions
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_ndr_branch_next_action_v2(jsonb) IS
  'W44 canonical RPC contract normalization. Wraps public.resolve_ndr_branch_next_action_v1 with the canonical (p_args jsonb) RETURNS jsonb envelope { ok, action }. Frontend cuts over to _v2; _v1 stays for any back-compat consumers.';

REVOKE ALL ON FUNCTION public.resolve_ndr_branch_next_action_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_ndr_branch_next_action_v2(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_ndr_branch_next_action_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_ndr_branch_next_action_v2(p_args);
$$;
REVOKE ALL ON FUNCTION api.resolve_ndr_branch_next_action_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.resolve_ndr_branch_next_action_v2(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.resolve_ndr_branch_next_action_v2(jsonb) IS
  'W44 api wrapper exposing public.resolve_ndr_branch_next_action_v2 (canonical jsonb envelope sibling of public.resolve_ndr_branch_next_action_v1).';

-- ===========================================================================
-- 4) transition_warehouse_transfer_v2
--
-- Underlying public.transition_warehouse_transfer_v1(JSONB) RETURNS TABLE
--   (warehouse_transfer_id, updated, status, dispatched_at, received_at).
-- The underlying RPC RETURN NEXT exactly once per call.
--
-- Envelope: { ok: true, warehouse_transfer_id, updated, status, dispatched_at, received_at }.
--
-- Note on grants: the underlying public.transition_warehouse_transfer_v1 is
-- intentionally service_role-only (it self-asserts service_role context inside
-- its body). We mirror that posture on the *_v2 sibling so least-privilege is
-- preserved end-to-end. The frontend production caller in console-v2 is the
-- supabase-js client which uses the supabase service role for warehouse-state
-- transition flows; live-mode browser sessions never invoke this RPC directly.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.transition_warehouse_transfer_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input jsonb := COALESCE(p_args, '{}'::jsonb);
  v_row   RECORD;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v2 expects a jsonb object payload' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_row
    FROM public.transition_warehouse_transfer_v1(v_input)
    LIMIT 1;

  RETURN jsonb_build_object(
    'ok', true,
    'warehouse_transfer_id', v_row.warehouse_transfer_id,
    'updated', v_row.updated,
    'status', v_row.status,
    'dispatched_at', v_row.dispatched_at,
    'received_at', v_row.received_at
  );
END;
$function$;

COMMENT ON FUNCTION public.transition_warehouse_transfer_v2(jsonb) IS
  'W44 canonical RPC contract normalization. Wraps public.transition_warehouse_transfer_v1 with the canonical (p_args jsonb) RETURNS jsonb envelope. Frontend cuts over to _v2; _v1 stays for any back-compat consumers (workflow handlers, reconcile/finalize callers). Grants mirror the underlying _v1 (service_role only).';

REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v2(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v2(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v2(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_warehouse_transfer_v2(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION api.transition_warehouse_transfer_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.transition_warehouse_transfer_v2(p_args);
$$;
REVOKE ALL ON FUNCTION api.transition_warehouse_transfer_v2(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.transition_warehouse_transfer_v2(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.transition_warehouse_transfer_v2(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.transition_warehouse_transfer_v2(jsonb) TO service_role;
COMMENT ON FUNCTION api.transition_warehouse_transfer_v2(jsonb) IS
  'W44 api wrapper exposing public.transition_warehouse_transfer_v2 (canonical jsonb envelope sibling of public.transition_warehouse_transfer_v1). Grants mirror the underlying _v1 (service_role only).';

-- ===========================================================================
-- 5) ui_get_trace_v2
--
-- Underlying public.ui_get_trace_v1(UUID) RETURNS jsonb -- already returns the
-- canonical { correlation_id, observability_events, domain_events,
-- workflow_runs } payload.
--
-- Envelope: { ok: true, trace: <existing_jsonb> }.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ui_get_trace_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args            jsonb := COALESCE(p_args, '{}'::jsonb);
  v_correlation_id  UUID;
  v_trace           jsonb;
BEGIN
  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_get_trace_v2 expects a jsonb object payload' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_correlation_id := NULLIF(btrim(COALESCE(v_args->>'correlation_id', '')), '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'ui_get_trace_v2 requires a uuid correlation_id' USING ERRCODE = '22023';
  END;

  v_trace := public.ui_get_trace_v1(v_correlation_id);

  RETURN jsonb_build_object(
    'ok', true,
    'trace', v_trace
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_get_trace_v2(jsonb) IS
  'W44 canonical RPC contract normalization. Wraps public.ui_get_trace_v1 with the canonical (p_args jsonb) RETURNS jsonb envelope { ok, trace }. Frontend cuts over to _v2; _v1 stays for any back-compat consumers.';

REVOKE ALL ON FUNCTION public.ui_get_trace_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_get_trace_v2(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_get_trace_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_get_trace_v2(p_args);
$$;
REVOKE ALL ON FUNCTION api.ui_get_trace_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_get_trace_v2(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.ui_get_trace_v2(jsonb) IS
  'W44 api wrapper exposing public.ui_get_trace_v2 (canonical jsonb envelope sibling of public.ui_get_trace_v1).';

-- ===========================================================================
-- 6) user_capability_eval_v2
--
-- Underlying public.user_capability_eval_v1(TEXT, TEXT, UUID) RETURNS jsonb --
-- already returns a populated jsonb evaluation envelope.
--
-- Envelope: { ok: true, eval: <existing_jsonb> }.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.user_capability_eval_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args            jsonb := COALESCE(p_args, '{}'::jsonb);
  v_capability_key  TEXT;
  v_scope_type      TEXT;
  v_scope_id        UUID;
  v_eval            jsonb;
BEGIN
  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'user_capability_eval_v2 expects a jsonb object payload' USING ERRCODE = '22023';
  END IF;

  v_capability_key := NULLIF(btrim(COALESCE(v_args->>'capability_key', '')), '');
  v_scope_type     := NULLIF(btrim(COALESCE(v_args->>'scope_type', '')), '');
  BEGIN
    v_scope_id := NULLIF(btrim(COALESCE(v_args->>'scope_id', '')), '')::uuid;
  EXCEPTION WHEN others THEN
    v_scope_id := NULL;
  END;

  IF v_capability_key IS NULL THEN
    RAISE EXCEPTION 'user_capability_eval_v2 requires capability_key' USING ERRCODE = '22023';
  END IF;

  v_eval := public.user_capability_eval_v1(v_capability_key, v_scope_type, v_scope_id);

  RETURN jsonb_build_object(
    'ok', true,
    'eval', v_eval
  );
END;
$function$;

COMMENT ON FUNCTION public.user_capability_eval_v2(jsonb) IS
  'W44 canonical RPC contract normalization. Wraps public.user_capability_eval_v1 with the canonical (p_args jsonb) RETURNS jsonb envelope { ok, eval }. Frontend cuts over to _v2; _v1 stays for any back-compat consumers (assert_capability_v1, user_has_capability_v1).';

REVOKE ALL ON FUNCTION public.user_capability_eval_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_capability_eval_v2(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.user_capability_eval_v2(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.user_capability_eval_v2(p_args);
$$;
REVOKE ALL ON FUNCTION api.user_capability_eval_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.user_capability_eval_v2(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.user_capability_eval_v2(jsonb) IS
  'W44 api wrapper exposing public.user_capability_eval_v2 (canonical jsonb envelope sibling of public.user_capability_eval_v1).';

SELECT pg_advisory_unlock(hashtext('202605020200_w44_rpc_v2_normalizations'));

COMMIT;
