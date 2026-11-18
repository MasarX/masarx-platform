-- Console V2 browser read secret redaction.
--
-- Purpose:
--   - Keep webhook source and provider credential browser reads projection-only.
--   - Ensure generic ui_list/ui_get resource reads cannot return auth_token,
--     credentials, or credentials_vault_id payloads.
--   - Keep new Console V2 credential writes Vault-backed with table plaintext
--     cleared.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605091045_console_v2_secret_redaction_browser_reads_v1'));

SET search_path TO public, vault, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

DROP VIEW IF EXISTS public.v_webhook_source_directory;

CREATE VIEW public.v_webhook_source_directory
  WITH (security_invoker = true)
  AS
SELECT
  ws.id,
  ws.organization_id,
  ws.source_identifier,
  ws.name,
  ws.provider_type,
  ws.mapping_config_id,
  ws.rate_limit_per_hour,
  ws.enabled,
  ws.created_at,
  ws.updated_at,
  mc.mapping_key AS mapping_label,
  inbox_agg.last_event_at,
  inbox_agg.last_event_status,
  COALESCE(inbox_agg.event_count_24h, 0) AS event_count_24h,
  COALESCE(inbox_agg.error_count_24h, 0) AS error_count_24h,
  COALESCE(rule_agg.rule_count, 0) AS rule_count,
  COALESCE(rule_agg.active_rule_count, 0) AS active_rule_count,
  (ws.enabled = TRUE AND COALESCE(inbox_agg.error_count_24h, 0) = 0) AS is_healthy,
  (COALESCE(inbox_agg.error_count_24h, 0) > 0) AS has_recent_errors,
  CASE
    WHEN ws.auth_token IS NOT NULL THEN 'stored'
    WHEN ws.auth_token_hash IS NOT NULL THEN 'stored'
    ELSE NULL
  END AS auth_token_masked,
  ws.sender_id,
  snd.client_id,
  snd.name AS sender_label,
  c.name AS client_label
FROM public.webhook_sources ws
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.senders snd ON snd.id = ws.sender_id
LEFT JOIN public.clients c ON c.id = snd.client_id
LEFT JOIN LATERAL (
  SELECT
    MAX(wi.created_at) AS last_event_at,
    (
      SELECT processing_status
        FROM public.webhook_inbox wi2
       WHERE wi2.webhook_source_id = ws.id
       ORDER BY wi2.created_at DESC
       LIMIT 1
    ) AS last_event_status,
    COUNT(*) FILTER (WHERE wi.created_at > now() - INTERVAL '24 hours') AS event_count_24h,
    COUNT(*) FILTER (
      WHERE wi.created_at > now() - INTERVAL '24 hours'
        AND wi.processing_status IN ('failed', 'dead_letter')
    ) AS error_count_24h
    FROM public.webhook_inbox wi
   WHERE wi.webhook_source_id = ws.id
) inbox_agg ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS rule_count,
    COUNT(*) FILTER (WHERE wr.enabled = TRUE) AS active_rule_count
    FROM public.webhook_rules wr
   WHERE wr.webhook_source_id = ws.id
) rule_agg ON TRUE;

COMMENT ON VIEW public.v_webhook_source_directory IS
  'Browser-safe Console V2 projection of webhook_sources with token status only. Excludes auth_token and auth_token_hash; mutations return one-time tokens through dedicated RPCs.';

REVOKE ALL ON public.v_webhook_source_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_source_directory FROM anon;
GRANT SELECT ON public.v_webhook_source_directory TO authenticated;
GRANT SELECT ON public.v_webhook_source_directory TO service_role;

CREATE OR REPLACE FUNCTION public.ui_upsert_provider_auth_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, vault, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_org_id UUID := public.current_user_org_id();
  v_config_id UUID := COALESCE(
    NULLIF(p_args->>'config_id', '')::uuid,
    NULLIF(p_args->>'provider_auth_config_id', '')::uuid
  );
  v_is_create BOOLEAN := v_config_id IS NULL;
  v_provider_id UUID := NULLIF(p_args->>'provider_id', '')::uuid;
  v_auth_type TEXT := NULLIF(btrim(p_args->>'auth_type'), '');
  v_credentials JSONB := CASE WHEN p_args ? 'credentials' THEN p_args->'credentials' ELSE NULL END;
  v_credentials_vault_id UUID := NULLIF(p_args->>'credentials_vault_id', '')::uuid;
  v_expires_at TIMESTAMPTZ := NULLIF(p_args->>'expires_at', '')::timestamptz;
  v_existing_provider_id UUID;
  v_target_org UUID;
  v_secret_name TEXT;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write');

  IF v_is_create AND v_config_id IS NULL THEN
    v_config_id := gen_random_uuid();
  END IF;

  IF v_is_create THEN
    IF v_provider_id IS NULL OR v_auth_type IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires provider_id and auth_type for create'
        USING ERRCODE = '23502';
    END IF;
    IF v_credentials IS NULL AND v_credentials_vault_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires credentials or credentials_vault_id for create'
        USING ERRCODE = '23502';
    END IF;
  END IF;

  IF NOT v_is_create THEN
    SELECT pac.provider_id, p.organization_id
      INTO v_existing_provider_id, v_target_org
      FROM public.provider_auth_configs pac
      JOIN public.providers p ON p.id = pac.provider_id
     WHERE pac.id = v_config_id
     LIMIT 1;

    IF v_existing_provider_id IS NULL OR v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % not found', v_config_id
        USING ERRCODE = '23503';
    END IF;

    IF v_provider_id IS NULL THEN
      v_provider_id := v_existing_provider_id;
    ELSIF v_provider_id <> v_existing_provider_id THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 config % belongs to provider %, not %',
        v_config_id, v_existing_provider_id, v_provider_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_is_create THEN
    SELECT organization_id INTO v_target_org
      FROM public.providers
     WHERE id = v_provider_id;
  END IF;

  IF v_provider_id IS NULL OR v_target_org IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider % not found', v_provider_id
      USING ERRCODE = '23503';
  END IF;

  IF v_user_org_id IS NOT NULL
     AND v_target_org <> v_user_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider % outside tenant scope', v_provider_id
      USING ERRCODE = '42501';
  END IF;

  IF v_credentials IS NOT NULL THEN
    IF jsonb_typeof(v_credentials) <> 'object' THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 credentials must be a JSON object'
        USING ERRCODE = '22023';
    END IF;

    IF v_is_create AND v_config_id IS NULL THEN
      v_config_id := gen_random_uuid();
    END IF;

    v_secret_name := format('provider_auth_configs/%s', v_config_id);
    SELECT vault.create_secret(
      v_credentials::text,
      v_secret_name,
      format('Console V2 provider credential %s', v_secret_name),
      NULL
    )
      INTO v_credentials_vault_id;
  END IF;

  IF v_is_create THEN
    INSERT INTO public.provider_auth_configs (
      id,
      provider_id,
      auth_type,
      credentials,
      credentials_vault_id,
      expires_at
    ) VALUES (
      v_config_id,
      v_provider_id,
      v_auth_type,
      NULL,
      v_credentials_vault_id,
      v_expires_at
    )
    RETURNING id INTO v_config_id;
  ELSE
    UPDATE public.provider_auth_configs
       SET auth_type = COALESCE(v_auth_type, auth_type),
           credentials = CASE
             WHEN v_credentials IS NOT NULL OR v_credentials_vault_id IS NOT NULL THEN NULL
             ELSE credentials
           END,
           credentials_vault_id = COALESCE(v_credentials_vault_id, credentials_vault_id),
           expires_at = CASE WHEN p_args ? 'expires_at' THEN v_expires_at ELSE expires_at END
     WHERE id = v_config_id
       AND provider_id = v_provider_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % not found', v_config_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'provider_auth_config_id', v_config_id,
    'auth_config_id', v_config_id,
    'credentials_vaulted', true,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb)
  IS 'Canonical write RPC: create/update provider_auth_configs with Vault-backed credential material. Capability: integration_plugins.write.';

CREATE OR REPLACE FUNCTION public.integration_plugin_rotate_credentials_v1(
  p_plugin_version_id UUID,
  p_auth_type TEXT,
  p_credentials JSONB,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, vault, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_provider_binding public.integration_plugin_bindings%ROWTYPE;
  v_auth_config_id UUID;
  v_credentials_vault_id UUID;
  v_secret_name TEXT;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires plugin_version_id';
  END IF;

  IF p_auth_type IS NULL OR btrim(p_auth_type) = '' THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires auth_type';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  SELECT * INTO v_provider_binding
  FROM public.integration_plugin_bindings b
  WHERE b.plugin_version_id = v_version.id
    AND b.binding_type = 'provider'
    AND b.runtime_resource_type = 'providers'
    AND b.enabled = TRUE
  ORDER BY b.created_at DESC
  LIMIT 1;

  IF v_provider_binding.id IS NULL OR v_provider_binding.runtime_resource_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires active provider binding';
  END IF;

  v_auth_config_id := gen_random_uuid();
  v_secret_name := format('provider_auth_configs/%s', v_auth_config_id);
  SELECT vault.create_secret(
    COALESCE(p_credentials, '{}'::jsonb)::text,
    v_secret_name,
    format('Console V2 integration plugin credential rotation %s', v_auth_config_id),
    NULL
  )
    INTO v_credentials_vault_id;

  INSERT INTO public.provider_auth_configs (
    id,
    provider_id,
    auth_type,
    credentials,
    credentials_vault_id,
    expires_at
  )
  VALUES (
    v_auth_config_id,
    v_provider_binding.runtime_resource_id,
    btrim(p_auth_type),
    NULL,
    v_credentials_vault_id,
    p_expires_at
  );

  UPDATE public.integration_plugin_versions
     SET auth_bindings = jsonb_set(
           jsonb_set(COALESCE(auth_bindings, '{}'::jsonb), '{latest_auth_config_id}', to_jsonb(v_auth_config_id::text), TRUE),
           '{latest_auth_type}',
           to_jsonb(btrim(p_auth_type)),
           TRUE
         ),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_version.id;

  INSERT INTO public.integration_plugin_approval_events (
    plugin_version_id,
    organization_id,
    action,
    actor_user_id,
    reason,
    diff_hash,
    artifact_hash,
    payload
  )
  VALUES (
    v_version.id,
    v_plugin.organization_id,
    'rotated_credentials',
    auth.uid(),
    NULLIF(btrim(COALESCE(p_reason, '')), ''),
    NULL,
    NULL,
    jsonb_build_object(
      'provider_id', v_provider_binding.runtime_resource_id,
      'auth_config_id', v_auth_config_id,
      'auth_type', btrim(p_auth_type),
      'credentials_vault_id', v_credentials_vault_id
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'provider_id', v_provider_binding.runtime_resource_id,
    'auth_config_id', v_auth_config_id,
    'provider_auth_config_id', v_auth_config_id,
    'credentials_vaulted', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.integration_plugin_rotate_credentials_v1(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_rotate_credentials_v1(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.integration_plugin_rotate_credentials_v1(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

DO $registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB;
  v_resources_to_add JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'webhook_sources',
      'label', 'Webhook sources',
      'relation', 'public.v_webhook_source_directory',
      'id_column', 'id',
      'capability_read', 'webhooks.read',
      'capability_write', 'webhooks.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'allow_view_relation', true,
      'columns', jsonb_build_array(
        jsonb_build_object('key', 'name', 'label', 'Name', 'sortable', true),
        jsonb_build_object('key', 'source_identifier', 'label', 'Source', 'mono', true, 'sortable', true, 'filterable', true),
        jsonb_build_object('key', 'provider_type', 'label', 'Provider', 'filterable', true, 'lookup', 'webhook_provider_type'),
        jsonb_build_object('key', 'mapping_config_id', 'label', 'Mapping', 'mono', true),
        jsonb_build_object('key', 'rate_limit_per_hour', 'label', 'Rate / hr', 'align', 'right', 'mono', true, 'sortable', true),
        jsonb_build_object('key', 'enabled', 'label', 'Enabled', 'filterable', true),
        jsonb_build_object('key', 'last_event_at', 'label', 'Last event', 'format', 'datetime'),
        jsonb_build_object('key', 'auth_token_masked', 'label', 'Token', 'mono', true)
      )
    ),
    jsonb_build_object(
      'key', 'provider_auth_configs',
      'label', 'Provider credentials',
      'relation', 'public.v_integration_credential_directory',
      'id_column', 'id',
      'capability_read', 'integrations.read',
      'capability_write', 'integrations.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'allow_view_relation', true,
      'columns', jsonb_build_array(
        jsonb_build_object('key', 'id', 'label', 'Config', 'mono', true, 'sortable', true),
        jsonb_build_object('key', 'provider_label', 'label', 'Provider', 'sortable', true, 'filterable', true),
        jsonb_build_object('key', 'auth_type', 'label', 'Auth type', 'sortable', true, 'filterable', true, 'lookup', 'provider_auth_type'),
        jsonb_build_object('key', 'status', 'label', 'Status', 'sortable', true, 'filterable', true),
        jsonb_build_object('key', 'days_until_expiry', 'label', 'Days', 'align', 'right', 'mono', true, 'sortable', true, 'type', 'number'),
        jsonb_build_object('key', 'last_rotated_at', 'label', 'Last rotated', 'format', 'datetime', 'sortable', true),
        jsonb_build_object('key', 'expires_at', 'label', 'Expires', 'format', 'datetime', 'sortable', true)
      )
    )
  );
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources_to_add) AS value LOOP
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO v_filtered
        FROM jsonb_array_elements(v_resources) AS value
       WHERE value->>'key' <> v_resource->>'key';
      v_resources := v_filtered || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Route browser secret resources through redacted Console V2 projections',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$registry$;

SELECT pg_advisory_unlock(hashtext('202605091045_console_v2_secret_redaction_browser_reads_v1'));

COMMIT;
