-- Spec-Issue: NETWORK W9 — close residual gaps on branches/zones canonical write RPCs
-- Step: W9-S03
-- Migration: branch_capacity_window_set_v1
-- Capability: branches.write
-- Date: 2026-04-30
--
-- Purpose:
--   Canonical write RPC: update capacity payload on public.branch_capacity_windows
--   row + decision_log + domain_event. Replaces the FE phaseC6Rpc shim path.
--
-- Args (jsonb):
--   { capacity_window_id (uuid, required),
--     capacity (jsonb, optional) — full payload merge,
--     capacity_units (numeric, optional) — convenience: sets capacity.max_units,
--     metadata (jsonb, optional) }
-- Envelope: { ok, branch_capacity_window_id, already_processed, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300420_branch_capacity_window_set_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.branch_capacity_window_set_v1(p_args JSONB)
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
  v_window public.branch_capacity_windows%ROWTYPE;
  v_branch public.branches%ROWTYPE;
  v_capacity JSONB := COALESCE(p_args->'capacity', NULL);
  v_capacity_units NUMERIC := NULLIF(p_args->>'capacity_units', '')::numeric;
  v_metadata JSONB := COALESCE(p_args->'metadata', NULL);
  v_new_capacity JSONB;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_capacity_window_set_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_window_id := NULLIF(p_args->>'capacity_window_id', '')::uuid;
  IF v_window_id IS NULL THEN
    RAISE EXCEPTION 'branch_capacity_window_set_v1 requires capacity_window_id' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_window FROM public.branch_capacity_windows WHERE id = v_window_id FOR UPDATE;
  IF v_window.id IS NULL THEN
    RAISE EXCEPTION 'branch_capacity_window_set_v1 capacity_window % not found', v_window_id USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = v_window.branch_id;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'branch_capacity_window_set_v1 branch % not found', v_window.branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'branch_capacity_window_set_v1 branch % outside tenant scope', v_window.branch_id USING ERRCODE = '42501';
  END IF;

  -- Build merged capacity: existing || provided capacity || convenience { max_units }.
  v_new_capacity := COALESCE(v_window.capacity, '{}'::jsonb)
                 || COALESCE(v_capacity, '{}'::jsonb);
  IF v_capacity_units IS NOT NULL THEN
    v_new_capacity := v_new_capacity || jsonb_build_object('max_units', to_jsonb(v_capacity_units));
  END IF;

  IF v_new_capacity = COALESCE(v_window.capacity, '{}'::jsonb)
     AND COALESCE(v_metadata, '{}'::jsonb) = '{}'::jsonb THEN
    v_already := TRUE;
  ELSE
    UPDATE public.branch_capacity_windows
       SET capacity = v_new_capacity,
           metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(v_metadata, '{}'::jsonb),
           updated_at = now()
     WHERE id = v_window_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_branch.organization_id, 'branch_capacity_window.updated', 'branch_capacity_window', v_window_id, v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'branch_id', v_window.branch_id,
        'zone_id', v_window.zone_id,
        'capacity', v_new_capacity,
        'capacity_units', to_jsonb(v_capacity_units)
      )),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.capacity_window_set',
    p_resource_type := 'branch_capacity_window',
    p_resource_id := v_window_id,
    p_decision_point := 'branch_capacity_window_set_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'no_change' ELSE 'updated' END,
    p_performed_by_system := 'branch_capacity_window_set_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'capacity_window_id', v_window_id,
      'capacity', v_capacity,
      'capacity_units', to_jsonb(v_capacity_units)
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_capacity_window_id', v_window_id,
    'already_processed', v_already,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.branch_capacity_window_set_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_capacity_window_set_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_capacity_window_set_v1(JSONB) IS
  'NETWORK W9 canonical write RPC: update branch_capacity_windows capacity + decision_log + domain_event. Capability: branches.write. Idempotent (no-op when payload unchanged).';

SELECT pg_advisory_unlock(hashtext('202604300420_branch_capacity_window_set_v1'));
COMMIT;
