-- Spec-Issue: Phase B6 - Catalog RPC contract: service_offering_create_v1
-- Step: B6-RPC-1
-- Capability: agreements.write (alias surface: service_offerings.write)

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280201_service_offering_create_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.service_offering_create_v1(p_args jsonb)
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
  v_resource_id UUID;
  v_service_level_id UUID := NULLIF(p_args->>'service_level_id', '')::uuid;
  v_branch_id UUID := NULLIF(p_args->>'branch_id', '')::uuid;
  v_zone_id UUID := NULLIF(p_args->>'zone_id', '')::uuid;
  v_priority INT := COALESCE((p_args->>'priority')::int, 0);
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_branch_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write');

  IF v_service_level_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_create_v1 requires service_level_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_create_v1 requires branch_id'
      USING ERRCODE = '23502';
  END IF;

  -- Tenant guard: branch must belong to caller's org (platform users bypass)
  SELECT organization_id INTO v_branch_org
    FROM public.branches WHERE id = v_branch_id;
  IF v_branch_org IS NULL THEN
    RAISE EXCEPTION 'service_offering_create_v1 branch % not found', v_branch_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_branch_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'service_offering_create_v1 branch % outside tenant scope', v_branch_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.service_offerings (
    service_level_id, branch_id, zone_id, priority, is_active, metadata
  ) VALUES (
    v_service_level_id, v_branch_id, v_zone_id, GREATEST(v_priority, 0), TRUE, v_metadata
  ) RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_branch_org, 'service_offerings.create', 'service_offering', v_resource_id,
    'service_offering_create_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object(
      'service_level_id', v_service_level_id,
      'branch_id', v_branch_id,
      'zone_id', v_zone_id,
      'priority', v_priority
    )),
    'service_offering_create_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_branch_org, 'service_offering.created', 'service_offering', v_resource_id,
    jsonb_build_object('service_level_id', v_service_level_id, 'branch_id', v_branch_id),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'service_offering_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.service_offering_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_offering_create_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_offering_create_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.service_offering_create_v1(jsonb)
  IS 'Canonical write RPC: insert service_offerings row + decision_log + domain_event. Capability: agreements.write.';

SELECT pg_advisory_unlock(hashtext('202604280201_service_offering_create_v1'));
COMMIT;
