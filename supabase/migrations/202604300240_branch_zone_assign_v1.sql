-- Spec-Issue: NETWORK W8 — close 100% gap on branches/zones canonical write RPCs
-- Step: W8-S05
-- Migration: branch_zone_assign_v1
-- Capability: branches.write
-- Date: 2026-04-30

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300240_branch_zone_assign_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.branch_zone_assign_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_id UUID;
  v_zone_id UUID;
  v_priority INT := NULLIF(p_args->>'priority', '')::int;
  v_branch_zone_id UUID;
  v_branch public.branches%ROWTYPE;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_zone_assign_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_branch_id := NULLIF(p_args->>'branch_id', '')::uuid;
  v_zone_id := NULLIF(p_args->>'zone_id', '')::uuid;
  IF v_branch_id IS NULL OR v_zone_id IS NULL THEN
    RAISE EXCEPTION 'branch_zone_assign_v1 requires branch_id and zone_id' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = v_branch_id;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'branch_zone_assign_v1 branch % not found', v_branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'branch_zone_assign_v1 branch % outside tenant scope', v_branch_id USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_branch_zone_id FROM public.branch_zones
    WHERE zone_id = v_zone_id AND branch_id = v_branch_id;
  IF v_branch_zone_id IS NOT NULL THEN
    v_already := TRUE;
  ELSE
    IF EXISTS (SELECT 1 FROM public.branch_zones WHERE zone_id = v_zone_id) THEN
      RAISE EXCEPTION 'branch_zone_assign_v1: zone % already assigned (call branch_zone_unassign_v1 first)', v_zone_id
        USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.branch_zones (branch_id, zone_id, priority)
    VALUES (v_branch_id, v_zone_id, v_priority)
    RETURNING id INTO v_branch_zone_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_branch.organization_id, 'branch_zone.assigned', 'branch_zone', v_branch_zone_id, v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'branch_id', v_branch_id,
        'zone_id', v_zone_id,
        'priority', v_priority
      )),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.zone_assign',
    p_resource_type := 'branch_zone',
    p_resource_id := v_branch_zone_id,
    p_decision_point := 'branch_zone_assign_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_assigned' ELSE 'assigned' END,
    p_performed_by_system := 'branch_zone_assign_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object('branch_id', v_branch_id, 'zone_id', v_zone_id, 'priority', v_priority)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_zone_id', v_branch_zone_id,
    'already_processed', v_already,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.branch_zone_assign_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_zone_assign_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_zone_assign_v1(JSONB) IS
  'NETWORK W8 canonical write RPC: assign zone -> branch via branch_zones row + decision_log + domain_event. Capability: branches.write.';

SELECT pg_advisory_unlock(hashtext('202604300240_branch_zone_assign_v1'));
COMMIT;
