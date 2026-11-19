-- Spec-Issue: Phase B6 - Catalog RPC contract: service_level_create_v1
-- Step: B6-RPC-5
-- Capability: agreements.write

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280205_service_level_create_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.service_level_create_v1(p_args jsonb)
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
  v_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'key', '')), ''));
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_description TEXT := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_target_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write');

  IF v_key IS NULL OR v_name IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 requires key and name'
      USING ERRCODE = '23502';
  END IF;

  -- Determine target org: explicit p_args override (platform users only) or caller's org.
  v_target_org := NULLIF(p_args->>'organization_id', '')::uuid;
  IF v_target_org IS NULL THEN
    v_target_org := v_org_id;
  ELSIF v_target_org <> COALESCE(v_org_id, v_target_org) AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'service_level_create_v1 organization_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 cannot resolve target organization'
      USING ERRCODE = '23502';
  END IF;

  INSERT INTO public.service_levels (
    organization_id, key, name, description, is_active, metadata
  ) VALUES (
    v_target_org, v_key, v_name, v_description, TRUE, v_metadata
  )
  RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org, 'service_levels.create', 'service_level', v_resource_id,
    'service_level_create_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object('key', v_key, 'name', v_name)),
    'service_level_create_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'service_level.created', 'service_level', v_resource_id,
    jsonb_build_object('key', v_key), v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'service_level_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.service_level_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_level_create_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_level_create_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.service_level_create_v1(jsonb)
  IS 'Canonical write RPC: insert service_levels row + decision_log + domain_event. Capability: agreements.write.';

SELECT pg_advisory_unlock(hashtext('202604280205_service_level_create_v1'));
COMMIT;
