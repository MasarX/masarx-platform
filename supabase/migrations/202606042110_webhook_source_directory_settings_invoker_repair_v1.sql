-- Keep webhook source directory reads security-invoker safe.
--
-- The directory projection must remain security_invoker, but authenticated
-- operators intentionally cannot read the raw settings table. Project the
-- safe HMAC display fields through a scoped security-definer helper instead.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606042110_webhook_source_directory_settings_invoker_repair_v1'));

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
) inbox_agg ON TRUE
LEFT JOIN LATERAL (
  SELECT
    count(*) AS rule_count,
    count(*) FILTER (WHERE wr.enabled = TRUE) AS active_rule_count
  FROM public.webhook_rules wr
  WHERE wr.webhook_source_id = ws.id
) rule_agg ON TRUE;

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

SELECT pg_advisory_unlock(hashtext('202606042110_webhook_source_directory_settings_invoker_repair_v1'));

COMMIT;
