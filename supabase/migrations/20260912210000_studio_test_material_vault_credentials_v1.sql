-- Canonical Vault-aware signing material; service-only permissions and source guards retained.
BEGIN;
CREATE OR REPLACE FUNCTION public.integration_studio_test_material_v1(
  p_actor_id uuid, p_source_id uuid, p_raw_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor public.users%ROWTYPE;
  v_access jsonb;
  v_capability text;
  v_source public.webhook_sources%ROWTYPE;
  v_token text;
  v_policy jsonb;
  v_hmac jsonb;
  v_secret text;
  v_auth_config_id uuid;
  v_credentials jsonb;
  v_header text;
  v_algorithm text;
  v_encoding text;
  v_signature text;
  v_headers jsonb;
  v_result jsonb;
BEGIN
  IF public.request_role_is_service_v1() IS NOT TRUE THEN
    RAISE EXCEPTION 'test material requires service authority' USING ERRCODE='42501';
  END IF;
  IF p_actor_id IS NULL OR p_source_id IS NULL OR p_raw_body IS NULL
     OR octet_length(p_raw_body)>65536 THEN
    RAISE EXCEPTION 'invalid test request' USING ERRCODE='22023';
  END IF;
  -- The Edge caller obtains this ID from auth.getUser(bearer), never request JSON.
  SELECT u.* INTO v_actor FROM public.users u JOIN public.organizations o ON o.id=u.organization_id
    WHERE u.id=p_actor_id AND lower(COALESCE(u.status,''))='active'
      AND lower(COALESCE(o.billing_status,'active'))<>'suspended';
  SELECT * INTO v_source FROM public.webhook_sources WHERE id=p_source_id;
  IF v_source.id IS NULL OR v_source.enabled IS NOT TRUE
     OR v_actor.id IS NULL OR v_actor.access_scope_type IS DISTINCT FROM 'tenant'
     OR v_actor.organization_id IS DISTINCT FROM v_source.organization_id
     OR v_source.managed_metadata->'test_enabled' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'test source not eligible' USING ERRCODE='42501';
  END IF;
  SELECT policy INTO v_access FROM public.resolve_access_control_policy_v1('tenant',v_source.organization_id,FALSE);
  FOREACH v_capability IN ARRAY ARRAY['webhooks.write','webhooks.read','integration_plugins.write'] LOOP
    IF NOT EXISTS(SELECT 1 FROM public.access_eval_capability_v1(v_access,v_capability,'tenant',
      v_source.organization_id,v_actor.id,v_actor.user_type) WHERE allowed IS TRUE) THEN
      RAISE EXCEPTION 'test source capability denied' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.senders s JOIN public.clients c ON c.id=s.client_id
    WHERE s.id=v_source.sender_id AND c.organization_id=v_source.organization_id
      AND COALESCE(s.status,'active')='active' AND COALESCE(c.status,'active')='active') THEN
    RAISE EXCEPTION 'test source sender unavailable' USING ERRCODE='42501';
  END IF;
  SELECT b.activation_payload->>'issued_token' INTO v_token
    FROM public.integration_plugin_bindings b
    JOIN public.integration_plugin_versions v ON v.id=b.plugin_version_id
    JOIN public.integration_plugins p ON p.id=v.plugin_id
    WHERE b.enabled AND b.binding_type='webhook_source'
      AND b.runtime_resource_type='webhook_sources' AND b.runtime_resource_id=v_source.id
      AND b.organization_id=v_source.organization_id AND v.organization_id=v_source.organization_id
      AND p.organization_id=v_source.organization_id
      AND public.integration_plugin_scope_belongs_org_v1(b.scope_type,b.scope_id,v_source.organization_id)
      AND NULLIF(b.activation_payload->>'issued_token','') IS NOT NULL
      AND crypt(b.activation_payload->>'issued_token',v_source.auth_token_hash)=v_source.auth_token_hash
    ORDER BY b.created_at DESC,b.id LIMIT 1;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'test source credential unavailable' USING ERRCODE='22023';
  END IF;
  SELECT policy INTO STRICT v_policy FROM public.resolve_webhook_ingest_policy(v_source.id);
  v_headers:=jsonb_build_object('content-type','application/json','x-webhook-token',v_token);
  v_hmac:=v_policy#>'{validation,hmac}';
  IF v_hmac->>'enabled'='true' THEN
    v_header:=lower(COALESCE(v_hmac->>'header','x-signature'));
    v_algorithm:=upper(COALESCE(v_hmac->>'algorithm','HMAC-SHA256'));
    v_encoding:=lower(COALESCE(v_hmac->>'signature_encoding','hex'));
    IF v_header !~ '^[a-z0-9][a-z0-9-]*$' OR v_header IN
      ('authorization','apikey','host','content-type','content-length','x-webhook-token','cookie','connection','transfer-encoding')
      OR v_algorithm NOT IN ('HMAC-SHA256','HMAC-SHA512') OR v_encoding NOT IN ('hex','base64') THEN
      RAISE EXCEPTION 'test source signing configuration unsupported' USING ERRCODE='22023';
    END IF;
    SELECT a.id INTO v_auth_config_id FROM public.provider_auth_configs a
      JOIN public.providers p ON p.id=a.provider_id
      WHERE a.id=NULLIF(v_hmac->>'auth_config_id','')::uuid
        AND p.organization_id=v_source.organization_id;
    IF v_auth_config_id IS NOT NULL THEN
      v_credentials:=public.get_provider_auth_credentials(v_auth_config_id);
      v_secret:=COALESCE(v_credentials->>'signing_secret',v_credentials->>'secret',v_credentials->>'api_key');
    END IF;
    IF NULLIF(v_secret,'') IS NULL THEN
      RAISE EXCEPTION 'test source signing material unavailable' USING ERRCODE='22023';
    END IF;
    v_signature:=encode(hmac(convert_to(p_raw_body,'UTF8'),convert_to(v_secret,'UTF8'),
      CASE WHEN v_algorithm='HMAC-SHA512' THEN 'sha512' ELSE 'sha256' END),v_encoding);
    IF v_encoding='base64' THEN v_signature:=replace(v_signature,E'\n',''); END IF;
    v_headers:=v_headers||jsonb_build_object(v_header,v_signature);
  END IF;
  v_result:=jsonb_build_object('source_id',v_source.id,'headers',v_headers);
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.integration_studio_test_material_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.integration_studio_test_material_v1(uuid,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION api.integration_studio_test_material_v1(p_actor_id uuid,p_source_id uuid,p_raw_body text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path TO public,extensions,pg_temp
AS $$ SELECT public.integration_studio_test_material_v1(p_actor_id,p_source_id,p_raw_body); $$;
REVOKE ALL ON FUNCTION api.integration_studio_test_material_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api.integration_studio_test_material_v1(uuid,uuid,text) TO service_role;
COMMIT;
