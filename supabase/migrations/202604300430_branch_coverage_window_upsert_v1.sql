-- Spec-Issue: NETWORK W9 — close residual gaps on branches/zones canonical write RPCs
-- Step: W9-S04
-- Migration: branch_coverage_window_upsert_v1
-- Capability: branches.write
-- Date: 2026-04-30
--
-- Purpose:
--   Canonical write RPC: insert OR update public.branch_coverage_windows row +
--   decision_log + domain_event. Replaces the FE phaseC6Rpc shim path.
--
-- Args (jsonb):
--   { branch_id (uuid, required for create),
--     zone_id (uuid, required for create),
--     coverage_window_id (uuid, optional — when present triggers update),
--     effective_from (timestamptz, optional — defaults to now() on create),
--     effective_to (timestamptz, optional),
--     priority (int, optional),
--     reason (text, optional),
--     metadata (jsonb, optional) }
-- Envelope: { ok, branch_coverage_window_id, action, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300430_branch_coverage_window_upsert_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.branch_coverage_window_upsert_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_window_id UUID;
  v_branch_id UUID;
  v_zone_id UUID;
  v_effective_from TIMESTAMPTZ := NULLIF(p_args->>'effective_from', '')::timestamptz;
  v_effective_to TIMESTAMPTZ := NULLIF(p_args->>'effective_to', '')::timestamptz;
  v_priority INT := NULLIF(p_args->>'priority', '')::int;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_metadata JSONB := COALESCE(p_args->'metadata', NULL);
  v_existing public.branch_coverage_windows%ROWTYPE;
  v_branch public.branches%ROWTYPE;
  v_action TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_coverage_window_upsert_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_window_id := NULLIF(p_args->>'coverage_window_id', '')::uuid;
  v_branch_id := NULLIF(p_args->>'branch_id', '')::uuid;
  v_zone_id := NULLIF(p_args->>'zone_id', '')::uuid;

  IF v_window_id IS NOT NULL THEN
    -- UPDATE path
    SELECT * INTO v_existing FROM public.branch_coverage_windows WHERE id = v_window_id FOR UPDATE;
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION 'branch_coverage_window_upsert_v1 coverage_window % not found', v_window_id USING ERRCODE = '23503';
    END IF;
    v_branch_id := COALESCE(v_branch_id, v_existing.branch_id);
    v_zone_id := COALESCE(v_zone_id, v_existing.zone_id);
  ELSE
    -- CREATE path requires branch_id + zone_id
    IF v_branch_id IS NULL OR v_zone_id IS NULL THEN
      RAISE EXCEPTION 'branch_coverage_window_upsert_v1 requires branch_id and zone_id for create' USING ERRCODE = '23502';
    END IF;
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = v_branch_id;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'branch_coverage_window_upsert_v1 branch % not found', v_branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'branch_coverage_window_upsert_v1 branch % outside tenant scope', v_branch_id USING ERRCODE = '42501';
  END IF;

  IF v_window_id IS NULL THEN
    -- CREATE
    v_effective_from := COALESCE(v_effective_from, now());
    INSERT INTO public.branch_coverage_windows (
      branch_id, zone_id, effective_from, effective_to, priority, reason, metadata
    ) VALUES (
      v_branch_id, v_zone_id, v_effective_from, v_effective_to, COALESCE(v_priority, 0), v_reason, v_metadata
    ) RETURNING id INTO v_window_id;
    v_action := 'created';
  ELSE
    -- UPDATE (partial)
    UPDATE public.branch_coverage_windows
       SET effective_from = COALESCE(v_effective_from, effective_from),
           effective_to = CASE WHEN p_args ? 'effective_to' THEN v_effective_to ELSE effective_to END,
           priority = COALESCE(v_priority, priority),
           reason = COALESCE(v_reason, reason),
           metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(v_metadata, '{}'::jsonb),
           updated_at = now()
     WHERE id = v_window_id;
    v_action := 'updated';
  END IF;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_branch.organization_id, 'branch_coverage_window.' || v_action, 'branch_coverage_window', v_window_id, v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'branch_id', v_branch_id,
      'zone_id', v_zone_id,
      'effective_from', to_jsonb(v_effective_from),
      'effective_to', to_jsonb(v_effective_to),
      'priority', to_jsonb(v_priority),
      'reason', v_reason
    )),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.coverage_window_upsert',
    p_resource_type := 'branch_coverage_window',
    p_resource_id := v_window_id,
    p_decision_point := 'branch_coverage_window_upsert_v1',
    p_decision_outcome := v_action,
    p_performed_by_system := 'branch_coverage_window_upsert_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'coverage_window_id', v_window_id,
      'branch_id', v_branch_id,
      'zone_id', v_zone_id,
      'effective_from', to_jsonb(v_effective_from),
      'effective_to', to_jsonb(v_effective_to),
      'priority', to_jsonb(v_priority),
      'reason', v_reason
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_coverage_window_id', v_window_id,
    'action', v_action,
    'already_processed', FALSE,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.branch_coverage_window_upsert_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_coverage_window_upsert_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_coverage_window_upsert_v1(JSONB) IS
  'NETWORK W9 canonical write RPC: insert OR update branch_coverage_windows row + decision_log + domain_event. Capability: branches.write. Action distinguishes created/updated.';

SELECT pg_advisory_unlock(hashtext('202604300430_branch_coverage_window_upsert_v1'));
COMMIT;
