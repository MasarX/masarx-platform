-- Spec-Issue: Phase B6 - Catalog RPC contract: service_offering_toggle_v1
-- Step: B6-RPC-4
-- Capability: agreements.write
-- Idempotent enable/disable toggle (controls is_active without changing effective window).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280204_service_offering_toggle_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.service_offering_toggle_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'service_offering_id', '')::uuid;
  v_target_active BOOLEAN := COALESCE((p_args->>'is_active')::boolean, NULL);
  v_branch_id UUID;
  v_branch_org UUID;
  v_current_active BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_toggle_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_toggle_v1 requires service_offering_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_target_active IS NULL THEN
    RAISE EXCEPTION 'service_offering_toggle_v1 requires is_active boolean'
      USING ERRCODE = '23502';
  END IF;

  SELECT branch_id, is_active INTO v_branch_id, v_current_active
    FROM public.service_offerings WHERE id = v_resource_id FOR UPDATE;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_toggle_v1 service_offering % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  SELECT organization_id INTO v_branch_org FROM public.branches WHERE id = v_branch_id;
  IF v_org_id IS NOT NULL
     AND v_branch_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'service_offering_toggle_v1 service_offering % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  IF v_current_active IS DISTINCT FROM v_target_active THEN
    UPDATE public.service_offerings
       SET is_active = v_target_active,
           updated_at = now()
     WHERE id = v_resource_id;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_branch_org, 'service_offerings.toggle', 'service_offering', v_resource_id,
    'service_offering_toggle_v1',
    CASE WHEN v_target_active THEN 'enabled' ELSE 'disabled' END,
    jsonb_build_object('is_active', v_target_active, 'previous_is_active', v_current_active),
    'service_offering_toggle_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_branch_org,
    CASE WHEN v_target_active THEN 'service_offering.enabled' ELSE 'service_offering.disabled' END,
    'service_offering', v_resource_id,
    jsonb_build_object('is_active', v_target_active),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'service_offering_id', v_resource_id,
    'is_active', v_target_active,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.service_offering_toggle_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_offering_toggle_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_offering_toggle_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.service_offering_toggle_v1(jsonb)
  IS 'Canonical write RPC: idempotent enable/disable on service_offerings (is_active flip). Capability: agreements.write.';

SELECT pg_advisory_unlock(hashtext('202604280204_service_offering_toggle_v1'));
COMMIT;
