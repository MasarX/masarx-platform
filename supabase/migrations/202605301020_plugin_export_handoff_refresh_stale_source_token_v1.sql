-- Console V2 plugin export handoff must recover plugin-owned source token drift.
-- The handoff is operator-visible setup data, so a stale binding token should
-- rotate the bound webhook source once and update binding lineage instead of
-- failing inside the drawer.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605301020_plugin_export_handoff_refresh_stale_source_token_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_client_id UUID := NULL;
  v_previous_hash TEXT := NULL;
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
  LIMIT 1
  FOR UPDATE;

  IF v_source.id IS NULL OR v_source.enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires an enabled webhook source for plugin version %', p_plugin_version_id;
  END IF;

  IF v_source.auth_token_hash IS NULL
     OR crypt(v_token, v_source.auth_token_hash) IS DISTINCT FROM v_source.auth_token_hash THEN
    v_previous_hash := v_source.auth_token_hash;

    IF v_source.sender_id IS NOT NULL THEN
      SELECT s.client_id
        INTO v_client_id
        FROM public.senders s
       WHERE s.id = v_source.sender_id
       LIMIT 1;
    END IF;

    IF v_previous_hash IS NOT NULL THEN
      INSERT INTO public.webhook_source_token_history (
        source_id,
        organization_id,
        client_id,
        sender_id,
        retired_auth_token_hash,
        retired_reason,
        retired_by_user_id,
        correlation_id,
        metadata
      )
      VALUES (
        v_source.id,
        v_source.organization_id,
        v_client_id,
        v_source.sender_id,
        v_previous_hash,
        'rotated',
        v_user_id,
        v_correlation_id,
        jsonb_build_object(
          'source_identifier', v_source.source_identifier,
          'refresh_reason', 'plugin_export_handoff_source_token_mismatch',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id,
          'binding_id', v_source_binding.id
        )
      )
      ON CONFLICT (source_id, retired_auth_token_hash) DO UPDATE
        SET retired_at = EXCLUDED.retired_at,
            retired_by_user_id = EXCLUDED.retired_by_user_id,
            correlation_id = EXCLUDED.correlation_id,
            metadata = public.webhook_source_token_history.metadata || EXCLUDED.metadata;
    END IF;

    v_token := encode(gen_random_bytes(32), 'hex');

    UPDATE public.webhook_sources
       SET auth_token = v_token,
           updated_at = now()
     WHERE id = v_source.id
     RETURNING * INTO v_source;

    UPDATE public.integration_plugin_bindings
       SET activation_payload = jsonb_strip_nulls(
             COALESCE(activation_payload, '{}'::jsonb)
             || jsonb_build_object(
                  'issued_token', v_token,
                  'issued_token_refreshed_at', now(),
                  'issued_token_refreshed_by', v_user_id,
                  'issued_token_refresh_reason', 'source_token_readback_mismatch',
                  'issued_token_refresh_correlation_id', v_correlation_id
                )
           )
     WHERE id = v_source_binding.id
     RETURNING * INTO v_source_binding;

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, v_source.organization_id,
      'webhooks.rotate_source_token', 'webhook_source', v_source.id,
      'integration_plugin_export_handoff_v1', 'rotated',
      jsonb_build_object(
        'plugin_id', v_plugin.id,
        'plugin_version_id', v_version.id,
        'binding_id', v_source_binding.id,
        'refresh_reason', 'source_token_readback_mismatch'
      ),
      'integration_plugin_export_handoff_v1', v_correlation_id
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_source.organization_id, 'webhook_source.token_rotated', 'webhook_source', v_source.id,
      jsonb_build_object(
        'plugin_id', v_plugin.id,
        'plugin_version_id', v_version.id,
        'binding_id', v_source_binding.id,
        'refresh_reason', 'source_token_readback_mismatch'
      ),
      v_correlation_id, 'pending'
    );
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

COMMENT ON FUNCTION public.integration_plugin_export_handoff_v1(UUID, TEXT)
  IS 'Exports a plugin runtime handoff from backend truth. If a plugin-owned webhook source token drifted from binding lineage, rotates the source token once, updates the binding issued-token lineage, and records retired-token/governance evidence before returning one-time token data.';

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

SELECT pg_advisory_unlock(hashtext('202605301020_plugin_export_handoff_refresh_stale_source_token_v1'));

COMMIT;
