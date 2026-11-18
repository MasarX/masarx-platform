-- Fail closed when plugin export handoff cannot resolve an issued source token.

CREATE OR REPLACE FUNCTION public.integration_plugin_export_handoff_v1(
  p_plugin_version_id UUID,
  p_base_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_source_binding public.integration_plugin_bindings%ROWTYPE;
  v_route_binding public.integration_plugin_bindings%ROWTYPE;
  v_source public.webhook_sources%ROWTYPE;
  v_route public.api_routes%ROWTYPE;
  v_base_url TEXT;
  v_token TEXT;
  v_endpoint TEXT;
  v_route_path TEXT;
  v_route_method TEXT;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires plugin_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write', 'tenant', v_plugin.organization_id);

  SELECT * INTO v_source_binding
  FROM public.integration_plugin_bindings b
  WHERE b.plugin_version_id = v_version.id
    AND b.binding_type = 'webhook_source'
    AND b.enabled = TRUE
  ORDER BY b.created_at DESC
  LIMIT 1;

  SELECT * INTO v_route_binding
  FROM public.integration_plugin_bindings b
  WHERE b.plugin_version_id = v_version.id
    AND b.binding_type = 'api_route'
    AND b.enabled = TRUE
  ORDER BY b.created_at DESC
  LIMIT 1;

  v_base_url := regexp_replace(NULLIF(btrim(COALESCE(p_base_url, '')), ''), '/+$', '');
  IF v_base_url IS NULL OR v_base_url LIKE '%{{%}}%' THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires a concrete base_url for plugin version %', p_plugin_version_id;
  END IF;

  v_token := NULLIF(btrim(COALESCE(v_source_binding.activation_payload->>'issued_token', '')), '');

  IF v_token IS NULL OR v_token LIKE '{{%}}' THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires an enabled source token binding for plugin version %', p_plugin_version_id;
  END IF;

  IF v_source_binding.runtime_resource_type IS DISTINCT FROM 'webhook_sources'
     OR v_source_binding.runtime_resource_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires a webhook source runtime binding for plugin version %', p_plugin_version_id;
  END IF;

  SELECT * INTO v_source
  FROM public.webhook_sources s
  WHERE s.id = v_source_binding.runtime_resource_id
    AND s.organization_id = v_plugin.organization_id
  LIMIT 1;

  IF v_source.id IS NULL OR v_source.enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires an enabled webhook source for plugin version %', p_plugin_version_id;
  END IF;

  IF v_source.auth_token_hash IS NULL
     OR crypt(v_token, v_source.auth_token_hash) IS DISTINCT FROM v_source.auth_token_hash THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 source token readback did not match issued binding token for plugin version %', p_plugin_version_id;
  END IF;

  IF lower(v_plugin.plugin_kind) = 'api' THEN
    IF v_route_binding.runtime_resource_type = 'api_routes'
       AND v_route_binding.runtime_resource_id IS NOT NULL THEN
      SELECT * INTO v_route
      FROM public.api_routes r
      WHERE r.id = v_route_binding.runtime_resource_id
        AND r.enabled = TRUE
      LIMIT 1;

      IF v_route.id IS NULL THEN
        RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires an enabled api route for plugin version %', p_plugin_version_id;
      END IF;

      v_route_path := COALESCE(v_route.path_template, '{{PATH_TEMPLATE}}');
      v_route_method := COALESCE(v_route.method, 'POST');
    ELSE
      RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires an enabled api route binding for plugin version %', p_plugin_version_id;
    END IF;

    IF NULLIF(btrim(COALESCE(v_route_path, '')), '') IS NULL OR v_route_path LIKE '%{{%}}%' THEN
      RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires a concrete api route path for plugin version %', p_plugin_version_id;
    END IF;

    v_endpoint := format('%s/functions/v1/api-gateway/t/%s%s', v_base_url, v_token, v_route_path);

    RETURN jsonb_build_object(
      'ok', TRUE,
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'kind', 'api',
      'endpoint', v_endpoint,
      'method', v_route_method,
      'token', v_token,
      'instructions', jsonb_build_array(
        'Replace your upstream base URL with endpoint base.',
        'Keep request body and headers mapping per plugin contract.',
        'Use issued token in path (/t/{token}/...) or Authorization Bearer token flow supported by gateway.'
      ),
      'sample_curl', format('curl -X %s "%s" -H "content-type: application/json" -d ''{}''', v_route_method, v_endpoint)
    );
  END IF;

  v_endpoint := format('%s/functions/v1/webhook-receiver', v_base_url);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'kind', 'webhook',
    'endpoint', v_endpoint,
    'token', v_token,
    'headers', jsonb_build_object('authorization', format('Bearer %s', v_token)),
    'instructions', jsonb_build_array(
      'Point webhook destination to endpoint.',
      'Send Authorization: Bearer {token}.',
      'Keep payload shape per plugin mapping configuration.'
    ),
    'sample_curl', format('curl -X POST "%s" -H "authorization: Bearer %s" -H "content-type: application/json" -d ''{}''', v_endpoint, v_token)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.integration_plugin_export_handoff_v1(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.integration_plugin_export_handoff_v1(UUID, TEXT) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.integration_plugin_export_handoff_v1(
  p_plugin_version_id UUID,
  p_base_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.integration_plugin_export_handoff_v1(p_plugin_version_id, p_base_url);
$function$;

REVOKE ALL ON FUNCTION api.integration_plugin_export_handoff_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.integration_plugin_export_handoff_v1(UUID, TEXT) FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.integration_plugin_export_handoff_v1(UUID, TEXT) TO authenticated, service_role;
