-- Spec-Issue: Phase B6 - Catalog RPC contract: service_offering_update_v1
-- Step: B6-RPC-2
-- Capability: agreements.write

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280202_service_offering_update_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.service_offering_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'service_offering_id', '')::uuid;
  v_before public.service_offerings%ROWTYPE;
  v_branch_org UUID;
  v_price JSONB := p_args->'price';
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_update_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_update_v1 requires service_offering_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.service_offerings WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'service_offering_update_v1 service_offering % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  SELECT organization_id INTO v_branch_org FROM public.branches WHERE id = v_before.branch_id;
  IF v_org_id IS NOT NULL
     AND v_branch_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'service_offering_update_v1 service_offering % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  IF v_price IS NOT NULL THEN
    IF jsonb_typeof(v_price) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_price->'base_price') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_price->'currency') IS DISTINCT FROM 'string'
       OR v_price - ARRAY['base_price', 'currency'] <> '{}'::jsonb
       OR p_args ? 'metadata' THEN
      RAISE EXCEPTION 'service_offering_update_v1 price requires base_price and currency only'
        USING ERRCODE = '22023';
    END IF;
    IF (v_price->>'base_price')::numeric <= 0 THEN
      RAISE EXCEPTION 'service_offering_update_v1 base_price must be positive' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.service_offerings
     SET zone_id = COALESCE(NULLIF(p_args->>'zone_id', '')::uuid, zone_id),
         priority = COALESCE((p_args->>'priority')::int, priority),
         effective_from = COALESCE((p_args->>'effective_from')::timestamptz, effective_from),
         effective_to = COALESCE((p_args->>'effective_to')::timestamptz, effective_to),
         is_active = COALESCE((p_args->>'is_active')::boolean, is_active),
         metadata = CASE WHEN v_price IS NOT NULL THEN COALESCE(metadata, '{}'::jsonb) || v_price
                         ELSE COALESCE(p_args->'metadata', metadata) END,
         updated_at = now()
   WHERE id = v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_branch_org, 'service_offerings.update', 'service_offering', v_resource_id,
    'service_offering_update_v1', 'updated', p_args,
    'service_offering_update_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_branch_org, 'service_offering.updated', 'service_offering', v_resource_id,
    p_args, v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'service_offering_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.service_offering_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_offering_update_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_offering_update_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.service_offering_update_v1(jsonb)
  IS 'Canonical write RPC: update service_offerings row + decision_log + domain_event. Capability: agreements.write.';

SELECT pg_advisory_unlock(hashtext('202604280202_service_offering_update_v1'));
COMMIT;
