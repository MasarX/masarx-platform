-- Spec-Issue: NETWORK W8 — close 100% gap on branches/zones canonical write RPCs
-- Step: W8-S06
-- Migration: branch_zone_unassign_v1
-- Capability: branches.write
-- Date: 2026-04-30

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300250_branch_zone_unassign_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.branch_zone_unassign_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_zone_id UUID := NULLIF(p_args->>'branch_zone_id', '')::uuid;
  v_branch_id UUID := NULLIF(p_args->>'branch_id', '')::uuid;
  v_zone_id UUID := NULLIF(p_args->>'zone_id', '')::uuid;
  v_row public.branch_zones%ROWTYPE;
  v_branch_org UUID;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_zone_unassign_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF v_branch_zone_id IS NULL AND (v_branch_id IS NULL OR v_zone_id IS NULL) THEN
    RAISE EXCEPTION 'branch_zone_unassign_v1 requires branch_zone_id or (branch_id + zone_id)'
      USING ERRCODE = '23502';
  END IF;

  IF v_branch_zone_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.branch_zones WHERE id = v_branch_zone_id FOR UPDATE;
  ELSE
    SELECT * INTO v_row FROM public.branch_zones
      WHERE branch_id = v_branch_id AND zone_id = v_zone_id FOR UPDATE;
  END IF;

  IF v_row.id IS NULL THEN
    v_already := TRUE;
    -- Use caller org for capability check when row is missing
    v_branch_org := public.current_user_org_id();
    PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch_org);
  ELSE
    SELECT organization_id INTO v_branch_org FROM public.branches WHERE id = v_row.branch_id;
    PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch_org);
    IF NOT public.is_platform_user() AND v_branch_org <> public.current_user_org_id() THEN
      RAISE EXCEPTION 'branch_zone_unassign_v1 branch_zone % outside tenant scope', v_row.id USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.branch_zones WHERE id = v_row.id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_branch_org, 'branch_zone.unassigned', 'branch_zone', v_row.id, v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'branch_id', v_row.branch_id,
        'zone_id', v_row.zone_id
      )),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := COALESCE(v_branch_org, public.current_user_org_id()),
    p_decision_category := 'branches.zone_unassign',
    p_resource_type := 'branch_zone',
    p_resource_id := COALESCE(v_row.id, v_branch_zone_id),
    p_decision_point := 'branch_zone_unassign_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_unassigned' ELSE 'unassigned' END,
    p_performed_by_system := 'branch_zone_unassign_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'branch_zone_id', v_branch_zone_id,
      'branch_id', v_branch_id,
      'zone_id', v_zone_id
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_zone_id', COALESCE(v_row.id, v_branch_zone_id),
    'already_processed', v_already,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.branch_zone_unassign_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_zone_unassign_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_zone_unassign_v1(JSONB) IS
  'NETWORK W8 canonical write RPC: remove branch_zones mapping + decision_log + domain_event. Capability: branches.write. Idempotent.';

SELECT pg_advisory_unlock(hashtext('202604300250_branch_zone_unassign_v1'));
COMMIT;
