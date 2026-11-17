-- External Intake source registry scope/readback repair.
--
-- Restore the canonical operator-safe webhook source directory projection and
-- ensure every scoped UI read registry carries one current webhook source
-- resource and one directory resource. This migration does not replay endpoint
-- or application code.

BEGIN;

SELECT pg_advisory_lock(hashtext('202608161300_b3_external_intake_source_registry_scope_readback_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.webhook_source_directory_policy_summary_v1(
  p_webhook_source_id UUID
)
RETURNS TABLE (
  hmac_enabled BOOLEAN,
  hmac_header TEXT,
  hmac_algorithm TEXT,
  hmac_signature_encoding TEXT,
  hmac_auth_config_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source_org UUID;
  v_user_org UUID;
  v_policy JSONB := '{}'::jsonb;
BEGIN
  IF p_webhook_source_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT ws.organization_id
    INTO v_source_org
    FROM public.webhook_sources ws
   WHERE ws.id = p_webhook_source_id
   LIMIT 1;

  IF v_source_org IS NULL THEN
    RAISE EXCEPTION 'webhook source policy is not available'
      USING ERRCODE = '42501';
  END IF;

  IF COALESCE(public.request_role_is_service_v1(), FALSE) IS DISTINCT FROM TRUE
     AND COALESCE(public.is_platform_user(), FALSE) IS DISTINCT FROM TRUE THEN
    v_user_org := public.current_user_org_id();
    IF v_user_org IS NULL OR v_user_org <> v_source_org THEN
      RAISE EXCEPTION 'webhook source policy is not available'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT COALESCE(s.cached_value, '{}'::jsonb)
    INTO v_policy
    FROM public.settings s
   WHERE s.category = 'webhook_ingest_policy'
     AND s.scope_type = 'source'
     AND s.scope_id = p_webhook_source_id
   LIMIT 1;

  RETURN QUERY
  SELECT
    COALESCE((v_policy#>>'{validation,hmac,enabled}')::BOOLEAN, FALSE),
    NULLIF(v_policy#>>'{validation,hmac,header}', ''),
    NULLIF(v_policy#>>'{validation,hmac,algorithm}', ''),
    NULLIF(v_policy#>>'{validation,hmac,signature_encoding}', ''),
    NULLIF(v_policy#>>'{validation,hmac,auth_config_id}', '')::UUID;
END;
$function$;

REVOKE ALL ON FUNCTION public.webhook_source_directory_policy_summary_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.webhook_source_directory_policy_summary_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.webhook_source_directory_policy_summary_v1(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.webhook_source_directory_policy_summary_v1(UUID)
  IS 'Scoped safe HMAC display summary for v_webhook_source_directory. Does not expose raw settings payloads.';

CREATE OR REPLACE VIEW public.v_webhook_source_directory
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
  COALESCE(NULLIF(mc.mapping_config->>'label', ''), mc.mapping_key) AS mapping_label,
  inbox_agg.last_event_at,
  inbox_agg.last_event_status,
  COALESCE(inbox_agg.event_count_24h, 0) AS event_count_24h,
  COALESCE(inbox_agg.error_count_24h, 0) AS error_count_24h,
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
  c.name AS client_label,
  COALESCE(source_policy.hmac_enabled, FALSE) AS hmac_enabled,
  source_policy.hmac_header,
  source_policy.hmac_algorithm,
  source_policy.hmac_signature_encoding,
  source_policy.hmac_auth_config_id,
  NULLIF(ws.managed_metadata->>'lifecycle', '') AS lifecycle_state,
  NULLIF(ws.managed_metadata->>'archived_at', '') AS archived_at,
  NULLIF(ws.managed_metadata->>'archived_by', '') AS archived_by,
  NULLIF(ws.managed_metadata->>'archive_reason', '') AS archive_reason,
  ws.managed_metadata
FROM public.webhook_sources ws
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.senders snd ON snd.id = ws.sender_id
LEFT JOIN public.clients c ON c.id = snd.client_id
LEFT JOIN LATERAL public.webhook_source_directory_policy_summary_v1(ws.id) source_policy ON TRUE
LEFT JOIN LATERAL (
  SELECT
    max(wi.created_at) AS last_event_at,
    (
      SELECT wi2.processing_status
      FROM public.webhook_inbox wi2
      WHERE wi2.webhook_source_id = ws.id
      ORDER BY wi2.created_at DESC
      LIMIT 1
    ) AS last_event_status,
    count(*) FILTER (WHERE wi.created_at > (now() - INTERVAL '24 hours')) AS event_count_24h,
    count(*) FILTER (
      WHERE wi.created_at > (now() - INTERVAL '24 hours')
        AND wi.processing_status IN ('failed', 'dead_letter')
    ) AS error_count_24h
  FROM public.webhook_inbox wi
  WHERE wi.webhook_source_id = ws.id
) inbox_agg ON TRUE;

REVOKE ALL ON public.v_webhook_source_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_source_directory FROM anon;
GRANT SELECT ON public.v_webhook_source_directory TO authenticated, service_role;

COMMENT ON VIEW public.v_webhook_source_directory
  IS 'FE-friendly webhook source projection with sender/client binding, source health, token redaction, HMAC policy state, archive lifecycle metadata, and operator-facing mapping_label from mapping_config.label with mapping_key fallback. Mutations go through ui_upsert_webhook_source_v1 / ui_rotate_webhook_source_token_v1 / ui_archive_webhook_source_v1.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_get_viewdef('public.v_webhook_source_directory'::regclass, true) AS view_sql
     WHERE view_sql ILIKE '%JOIN public.settings%'
        OR view_sql ILIKE '%JOIN settings%'
  ) THEN
    RAISE EXCEPTION 'v_webhook_source_directory must not directly join raw settings';
  END IF;
END;
$$;
DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_existing_source JSONB;
  v_existing_directory JSONB;
  v_source_resource JSONB;
  v_directory_resource JSONB;
  v_next JSONB;
  v_scope_columns JSONB := jsonb_build_object(
    'tenant', 'organization_id',
    'client', 'client_id',
    'sender', 'sender_id'
  );
  v_source_template JSONB := jsonb_build_object(
    'key', 'webhook_sources',
    'label', 'Webhook sources',
    'relation', 'public.v_webhook_source_directory',
    'allow_view_relation', true,
    'id_column', 'id',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    'capability_read', 'webhooks.read',
    'capability_write', 'webhooks.write',
    'select', jsonb_build_array(
      'id','organization_id','sender_id','source_identifier','name','provider_type',
      'mapping_config_id','rate_limit_per_hour','enabled','created_at','updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
      jsonb_build_object('key','source_identifier','column','source_identifier','op','ilike'),
      jsonb_build_object('key','provider_type','column','provider_type','op','eq'),
      jsonb_build_object('key','enabled','column','enabled','op','eq'),
      jsonb_build_object('key','sender_id','column','sender_id','op','eq')
    ),
    'default_sort', jsonb_build_object('column','created_at','direction','desc')
  );
  v_directory_template JSONB := jsonb_build_object(
    'key', 'webhook_source_directory',
    'relation', 'public.v_webhook_source_directory',
    'allow_view_relation', true,
    'id_column', 'id',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    'capability_read', 'webhooks.read',
    'capability_write', 'webhooks.write',
    'default_sort', jsonb_build_object('column', 'last_event_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'source_identifier', 'column', 'source_identifier', 'op', 'ilike'),
      jsonb_build_object('key', 'provider_type', 'column', 'provider_type', 'op', 'eq'),
      jsonb_build_object('key', 'mapping_config_id', 'column', 'mapping_config_id', 'op', 'eq'),
      jsonb_build_object('key', 'enabled', 'column', 'enabled', 'op', 'eq')
    )
  );
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    SELECT resource
      INTO v_existing_source
      FROM jsonb_array_elements(v_resources) WITH ORDINALITY AS r(resource, ordinality)
     WHERE resource->>'key' = 'webhook_sources'
     ORDER BY ordinality DESC
     LIMIT 1;

    SELECT resource
      INTO v_existing_directory
      FROM jsonb_array_elements(v_resources) WITH ORDINALITY AS r(resource, ordinality)
     WHERE resource->>'key' = 'webhook_source_directory'
     ORDER BY ordinality DESC
     LIMIT 1;

    SELECT COALESCE(jsonb_agg(resource ORDER BY ordinality), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_resources) WITH ORDINALITY AS r(resource, ordinality)
     WHERE resource->>'key' NOT IN ('webhook_sources', 'webhook_source_directory');

    v_source_resource := COALESCE(v_existing_source, '{}'::jsonb) || v_source_template;
    v_source_resource := jsonb_set(
      v_source_resource,
      '{scope_columns}',
      COALESCE(v_existing_source->'scope_columns', '{}'::jsonb) || v_scope_columns,
      TRUE
    );

    v_directory_resource := COALESCE(v_existing_directory, '{}'::jsonb) || v_directory_template;
    v_directory_resource := jsonb_set(
      v_directory_resource,
      '{scope_columns}',
      COALESCE(v_existing_directory->'scope_columns', '{}'::jsonb) || v_scope_columns,
      TRUE
    );

    v_next := jsonb_set(
      v_current,
      '{resources}',
      v_filtered || jsonb_build_array(v_source_resource, v_directory_resource),
      TRUE
    );

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'External Intake source directory and scoped registry repair',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_next;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%webhook_sources%'
      OR cache_key LIKE 'ui_get_resource:%webhook_sources%'
      OR cache_key LIKE 'ui_list_resource:%webhook_source_directory%'
      OR cache_key LIKE 'ui_get_resource:%webhook_source_directory%';
END;
$registry$;

DO $assert$
BEGIN
  IF to_regclass('public.v_webhook_source_directory') IS NULL THEN
    RAISE EXCEPTION 'v_webhook_source_directory is missing after External Intake repair';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND (
         (
           SELECT count(*)
            FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
            WHERE resource->>'key' = 'webhook_sources'
              AND resource->>'relation' = 'public.v_webhook_source_directory'
              AND resource#>>'{scope_columns,tenant}' = 'organization_id'
              AND resource#>>'{scope_columns,client}' = 'client_id'
              AND resource#>>'{scope_columns,sender}' = 'sender_id'
              AND resource->>'capability_read' = 'webhooks.read'
              AND resource->>'capability_write' = 'webhooks.write'
         ) <> 1
         OR
         (
           SELECT count(*)
             FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
            WHERE resource->>'key' = 'webhook_source_directory'
              AND resource->>'relation' = 'public.v_webhook_source_directory'
              AND resource#>>'{scope_columns,tenant}' = 'organization_id'
              AND resource#>>'{scope_columns,client}' = 'client_id'
              AND resource#>>'{scope_columns,sender}' = 'sender_id'
              AND resource->>'capability_read' = 'webhooks.read'
              AND resource->>'capability_write' = 'webhooks.write'
         ) <> 1
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
             CROSS JOIN LATERAL jsonb_each_text(COALESCE(resource->'scope_columns', '{}'::jsonb)) AS scope(scope_type, column_name)
            WHERE resource->>'key' IN ('webhook_sources', 'webhook_source_directory')
              AND NOT EXISTS (
                SELECT 1
                  FROM information_schema.columns column_info
                 WHERE column_info.table_schema = split_part(resource->>'relation', '.', 1)
                   AND column_info.table_name = split_part(resource->>'relation', '.', 2)
                   AND column_info.column_name = scope.column_name
              )
         )
       )
  ) THEN
    RAISE EXCEPTION 'External Intake source resources are missing, duplicated, or incorrectly scoped in ui_read_registry';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202608161300_b3_external_intake_source_registry_scope_readback_v1'));

COMMIT;
