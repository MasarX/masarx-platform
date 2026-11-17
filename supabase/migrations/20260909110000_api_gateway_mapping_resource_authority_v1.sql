-- Use canonical route resource authority without changing mapping or ownership gates.
BEGIN;

CREATE OR REPLACE FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := COALESCE(
    public.mapping_studio_try_uuid_v1(p_args->>'organization_id'),
    public.current_user_org_id()
  );
  v_route_id UUID := public.mapping_studio_try_uuid_v1(p_args->>'api_route_id');
  v_mapping_id UUID := public.mapping_studio_try_uuid_v1(p_args->>'mapping_config_id');
  v_route public.api_routes%ROWTYPE;
  v_mapping public.mapping_configs%ROWTYPE;
  v_target TEXT;
  v_scope_type TEXT;
  v_route_intent TEXT;
  v_mapping_intent TEXT;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires object args';
  END IF;
  IF v_org_id IS NULL OR v_route_id IS NULL OR v_mapping_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires organization, api_route_id, and mapping_config_id';
  END IF;

  IF NOT public.request_role_is_service_v1()
     AND public.user_has_resource_capability_v1('api_routes', 'write', 'tenant', v_org_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Capability denied: api_routes.write' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);

  SELECT * INTO v_route FROM public.api_routes WHERE id = v_route_id LIMIT 1;
  IF v_route.id IS NULL THEN
    RAISE EXCEPTION 'api_gateway route % is not available in this tenant scope', v_route_id;
  END IF;

  SELECT *
  INTO v_mapping
  FROM public.mapping_configs
  WHERE id = v_mapping_id
    AND mapping_type = 'api_gateway_inbound'
    AND (organization_id IS NULL OR organization_id = v_org_id)
  LIMIT 1;
  IF v_mapping.id IS NULL THEN
    RAISE EXCEPTION 'api_gateway_inbound mapping config % is not available in this tenant scope', v_mapping_id;
  END IF;

  v_target := COALESCE(NULLIF(v_mapping.mapping_config->>'target', ''), NULLIF(p_args->>'target', ''));
  v_scope_type := lower(COALESCE(NULLIF(v_route.scope_type, ''), 'global'));
  v_route_intent := public.api_gateway_route_canonical_intent_v1(COALESCE(v_route.policy, '{}'::jsonb));
  v_mapping_intent := public.api_gateway_mapping_target_intent_v1(v_target);

  IF v_scope_type = 'global' THEN
    IF public.user_has_capability_v1('system.write', 'tenant', v_org_id) IS FALSE THEN
      RAISE EXCEPTION 'api_gateway global route % is service-managed for tenant mapping', v_route_id;
    END IF;
  ELSIF v_scope_type = 'tenant' THEN
    IF v_route.scope_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'api_gateway tenant route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'client' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = v_route.scope_id AND c.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway client route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'sender' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = v_route.scope_id AND c.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway sender route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'source' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.webhook_sources ws
      WHERE ws.id = v_route.scope_id AND ws.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway source route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'api_gateway route % has unsupported scope_type %', v_route_id, v_scope_type;
  END IF;

  IF public.api_gateway_mapping_intents_compatible_v1(v_route_intent, v_mapping_intent) IS FALSE THEN
    RAISE EXCEPTION 'api_gateway mapping target % is incompatible with route intent %',
      COALESCE(v_target, ''), COALESCE(v_route_intent, '');
  END IF;

  UPDATE public.api_routes
  SET policy = public.deep_merge_jsonb(
        COALESCE(policy, '{}'::jsonb),
        jsonb_build_object(
          'request_mapping',
          jsonb_strip_nulls(jsonb_build_object(
            'mapping_config_id', v_mapping.id,
            'mapping_key', v_mapping.mapping_key,
            'mapping_type', v_mapping.mapping_type,
            'target', v_target,
            'route_intent', v_route_intent,
            'mapping_intent', v_mapping_intent,
            'route_scope_type', v_scope_type,
            'route_scope_id', v_route.scope_id,
            'saved_at', now(),
            'saved_by', v_user_id
          ))
        )
      ),
      updated_at = now()
  WHERE id = v_route.id
  RETURNING * INTO v_route;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'api_route_id', v_route.id,
    'mapping_config_id', v_mapping.id,
    'mapping_key', v_mapping.mapping_key,
    'mapping_type', v_mapping.mapping_type,
    'mapping_target', v_target,
    'route_intent', v_route_intent,
    'mapping_intent', v_mapping_intent,
    'route_scope_type', v_scope_type,
    'route_scope_id', v_route.scope_id,
    'policy', v_route.policy
  ));
END;
$function$;

COMMIT;
