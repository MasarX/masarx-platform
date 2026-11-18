-- Preserve selected plugin export token-binding behavior in the canonical RPC.
-- Selected authority: E52, donor f05e3a9a648cea7e7a7dbf1ec0a91c9429de95d8,
-- blob 826a25ba0023fb11e8dc5c12d734bacefb0e4c25.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.integration_plugin_export_handoff_v1(
  p_plugin_version_id UUID, p_base_url TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp SET row_security = on
AS $function$
DECLARE
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_binding public.integration_plugin_bindings%ROWTYPE;
  v_route_binding public.integration_plugin_bindings%ROWTYPE;
  v_source public.webhook_sources%ROWTYPE;
  v_route public.api_routes%ROWTYPE;
  v_client_id UUID;
  v_token TEXT;
  v_base TEXT := regexp_replace(NULLIF(btrim(p_base_url), ''), '/+$', '');
  v_endpoint TEXT;
  v_reason TEXT;
  v_correlation UUID := gen_random_uuid();
  v_previous_correlation TEXT := current_setting('request.correlation_id', TRUE);
BEGIN
  SELECT * INTO STRICT v_version FROM public.integration_plugin_versions WHERE id=p_plugin_version_id;
  SELECT * INTO STRICT v_plugin FROM public.integration_plugins WHERE id=v_version.plugin_id;
  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'plugin export outside actor organization' USING ERRCODE='42501';
  END IF;
  PERFORM public.assert_capability_v1('integration_plugins.write', 'tenant', v_plugin.organization_id);
  IF v_version.organization_id IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'plugin version organization mismatch' USING ERRCODE='42501';
  END IF;
  IF v_base IS NULL OR v_base LIKE '%{{%}}%' THEN
    RAISE EXCEPTION 'plugin export requires a concrete base_url' USING ERRCODE='22023';
  END IF;
  -- Export appends its own resource path: credentials, query/fragment and control
  -- characters cannot form part of that base. No network request occurs here.
  IF v_base !~ '^https?://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$'
     OR v_base ~ '[[:cntrl:]]' OR position(chr(92) IN v_base)>0 THEN
    RAISE EXCEPTION 'plugin export requires an HTTP(S) base without credentials, query or fragment'
      USING ERRCODE='22023';
  END IF;
  SELECT b.* INTO v_binding FROM public.integration_plugin_bindings b
  LEFT JOIN public.webhook_sources s ON s.id=b.runtime_resource_id AND b.runtime_resource_type='webhook_sources'
  WHERE b.plugin_version_id=v_version.id AND b.organization_id=v_plugin.organization_id
    AND b.binding_type='webhook_source' AND b.enabled
  ORDER BY (s.sender_id IS NOT NULL) DESC,
    (NULLIF(btrim(b.activation_payload->>'issued_token'),'') IS NOT NULL
      AND b.activation_payload->>'issued_token' <> 'REDACTED'
      AND b.activation_payload->>'issued_token' NOT LIKE '{{%}}') DESC,
    b.created_at DESC, b.id
  LIMIT 1 FOR UPDATE OF b;
  IF v_binding.runtime_resource_type IS DISTINCT FROM 'webhook_sources' OR v_binding.runtime_resource_id IS NULL THEN
    RAISE EXCEPTION 'plugin export requires a webhook source runtime binding' USING ERRCODE='22023';
  END IF;
  IF public.integration_plugin_scope_belongs_org_v1(v_binding.scope_type,v_binding.scope_id,v_plugin.organization_id) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'plugin export binding outside tenant scope' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_source FROM public.webhook_sources
  WHERE id=v_binding.runtime_resource_id AND organization_id=v_plugin.organization_id FOR UPDATE;
  IF v_source.id IS NULL OR v_source.enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'plugin export requires an enabled tenant webhook source' USING ERRCODE='22023';
  END IF;
  IF v_source.sender_id IS NULL AND lower(COALESCE(NULLIF(v_version.workflow_binding->>'intent',''),
    NULLIF(v_version.mapping_config->>'target',''),NULLIF(v_version.mapping_config#>>'{metadata,target}','')))
    IN ('shipment.create','shipments.create') THEN
    RAISE EXCEPTION 'shipment-create plugin export requires a sender-bound webhook source' USING ERRCODE='22023';
  END IF;
  -- Validate the complete route before any token mutation. Global/tenant route policy
  -- semantics remain those of the existing bound-route contract.
  IF lower(v_plugin.plugin_kind)='api' THEN
    SELECT * INTO v_route_binding FROM public.integration_plugin_bindings
    WHERE plugin_version_id=v_version.id AND organization_id=v_plugin.organization_id
      AND binding_type='api_route' AND enabled ORDER BY created_at DESC,id LIMIT 1 FOR UPDATE;
    IF v_route_binding.runtime_resource_type IS DISTINCT FROM 'api_routes' THEN
      RAISE EXCEPTION 'plugin export requires an api route binding' USING ERRCODE='22023';
    END IF;
    IF public.integration_plugin_scope_belongs_org_v1(v_route_binding.scope_type,v_route_binding.scope_id,v_plugin.organization_id) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'plugin export route binding outside tenant scope' USING ERRCODE='42501';
    END IF;
    SELECT s.client_id INTO v_client_id FROM public.senders s WHERE s.id=v_source.sender_id;
    -- Preserve the gateway's complete scope ladder, including legitimate global routes.
    -- A foreign or disabled-pack route must fail before token repair or audit writes.
    SELECT r.* INTO v_route FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id=r.pack_id AND p.enabled
    WHERE r.id=v_route_binding.runtime_resource_id AND r.enabled
      AND ((r.scope_type='source' AND r.scope_id=v_source.id)
        OR (r.scope_type='sender' AND r.scope_id=v_source.sender_id)
        OR (r.scope_type='client' AND r.scope_id=v_client_id)
        OR (r.scope_type='tenant' AND r.scope_id=v_plugin.organization_id)
        OR (r.scope_type='global' AND r.scope_id IS NULL))
    FOR SHARE OF r,p;
    IF v_route.id IS NULL OR NULLIF(btrim(v_route.path_template),'') IS NULL OR v_route.path_template LIKE '%{{%}}%' THEN
      RAISE EXCEPTION 'plugin export requires a concrete enabled api route' USING ERRCODE='22023';
    END IF;
  END IF;
  v_token := NULLIF(btrim(v_binding.activation_payload->>'issued_token'),'');
  IF v_token IS NULL OR v_token='REDACTED' OR v_token LIKE '{{%}}%' THEN
    v_reason := 'missing_source_token_binding';
  ELSIF v_source.auth_token_hash IS NULL OR crypt(v_token,v_source.auth_token_hash) IS DISTINCT FROM v_source.auth_token_hash THEN
    v_reason := 'source_token_readback_mismatch';
  END IF;
  IF v_reason IS NOT NULL THEN
    v_token := encode(gen_random_bytes(32),'hex');
    PERFORM set_config('request.correlation_id',v_correlation::TEXT,TRUE);
    -- Canonical hashing + immutable lineage triggers own the prior hash exactly once.
    -- Do not replay the donor's history UPSERT or add webhooks.write prerequisites.
    UPDATE public.webhook_sources SET auth_token=v_token,updated_at=clock_timestamp()
    WHERE id=v_source.id RETURNING * INTO v_source;
    UPDATE public.integration_plugin_bindings SET activation_payload=COALESCE(activation_payload,'{}'::jsonb)
      ||jsonb_build_object('issued_token',v_token,'issued_token_refreshed_at',clock_timestamp(),
        'issued_token_refreshed_by',auth.uid(),'issued_token_refresh_reason',v_reason,
        'issued_token_refresh_correlation_id',v_correlation),updated_at=clock_timestamp()
    WHERE id=v_binding.id;
    INSERT INTO public.decision_log(id,organization_id,decision_category,resource_type,resource_id,
      decision_point,decision_outcome,decision_inputs,performed_by_system,correlation_id)
    VALUES(gen_random_uuid(),v_plugin.organization_id,'webhooks.rotate_source_token','webhook_source',v_source.id,
      'integration_plugin_export_handoff_v1',CASE WHEN v_reason='missing_source_token_binding' THEN 'issued' ELSE 'rotated' END,
      jsonb_build_object('plugin_id',v_plugin.id,'plugin_version_id',v_version.id,'binding_id',v_binding.id,'refresh_reason',v_reason),
      'integration_plugin_export_handoff_v1',v_correlation);
    INSERT INTO public.domain_events(organization_id,event_type,resource_type,resource_id,payload,correlation_id,status)
    VALUES(v_plugin.organization_id,'webhook_source.token_rotated','webhook_source',v_source.id,
      jsonb_build_object('plugin_id',v_plugin.id,'plugin_version_id',v_version.id,'binding_id',v_binding.id,'refresh_reason',v_reason),
      v_correlation,'pending');
    PERFORM set_config('request.correlation_id',COALESCE(v_previous_correlation,''),TRUE);
  END IF;
  IF v_source.auth_token_hash IS NULL OR crypt(v_token,v_source.auth_token_hash) IS DISTINCT FROM v_source.auth_token_hash THEN
    RAISE EXCEPTION 'plugin export source token readback mismatch';
  END IF;
  IF lower(v_plugin.plugin_kind)='api' THEN
    v_endpoint:=format('%s/functions/v1/api-gateway/t/%s%s',v_base,v_token,v_route.path_template);
    RETURN jsonb_build_object('ok',TRUE,'plugin_id',v_plugin.id,'plugin_version_id',v_version.id,'kind','api',
      'endpoint',v_endpoint,'method',v_route.method,'token',v_token,
      'instructions',jsonb_build_array('Replace your upstream base URL with endpoint base.','Keep request body and headers mapping per plugin contract.',
        'Use issued token in path (/t/{token}/...) or Authorization Bearer token flow supported by gateway.'),
      -- POSIX shell literals: embedded quotes cannot become command substitutions.
      'sample_curl',format('curl --globoff -X %s --url %s -H ''content-type: application/json'' -d ''{}''',
        chr(39)||replace(v_route.method,chr(39),chr(39)||chr(34)||chr(39)||chr(34)||chr(39))||chr(39),
        chr(39)||replace(v_endpoint,chr(39),chr(39)||chr(34)||chr(39)||chr(34)||chr(39))||chr(39)));
  END IF;
  v_endpoint:=format('%s/functions/v1/webhook-receiver',v_base);
  RETURN jsonb_build_object('ok',TRUE,'plugin_id',v_plugin.id,'plugin_version_id',v_version.id,'kind','webhook',
    'endpoint',v_endpoint,'token',v_token,'headers',jsonb_build_object('authorization',format('Bearer %s',v_token)),
    'instructions',jsonb_build_array('Point webhook destination to endpoint.','Send Authorization: Bearer {token}.','Keep payload shape per plugin mapping configuration.'),
    'sample_curl',format('curl --globoff -X POST --url %s -H %s -H ''content-type: application/json'' -d ''{}''',
      chr(39)||replace(v_endpoint,chr(39),chr(39)||chr(34)||chr(39)||chr(34)||chr(39))||chr(39),
      chr(39)||replace('authorization: Bearer '||v_token,chr(39),chr(39)||chr(34)||chr(39)||chr(34)||chr(39))||chr(39)));
END;
$function$;
REVOKE ALL ON FUNCTION public.integration_plugin_export_handoff_v1(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.integration_plugin_export_handoff_v1(UUID,TEXT) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION api.integration_plugin_export_handoff_v1(p_plugin_version_id UUID,p_base_url TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE SQL SECURITY INVOKER SET search_path TO public,extensions,pg_temp
AS $$ SELECT public.integration_plugin_export_handoff_v1(p_plugin_version_id,p_base_url); $$;
REVOKE ALL ON FUNCTION api.integration_plugin_export_handoff_v1(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.integration_plugin_export_handoff_v1(UUID,TEXT) TO authenticated,service_role;
COMMIT;
