-- Migration: Prefer operator-facing mapping labels in webhook source directory.
-- The column shape is unchanged. `mapping_label` remains the Console-facing
-- projection, but now resolves from mapping_configs.mapping_config.label first
-- and falls back to the canonical mapping key when no label is configured.

BEGIN;

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
  COALESCE((source_policy.cached_value#>>'{validation,hmac,enabled}')::boolean, FALSE) AS hmac_enabled,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,header}', '') AS hmac_header,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,algorithm}', '') AS hmac_algorithm,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,signature_encoding}', '') AS hmac_signature_encoding,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,auth_config_id}', '')::uuid AS hmac_auth_config_id,
  NULLIF(ws.managed_metadata->>'lifecycle', '') AS lifecycle_state,
  NULLIF(ws.managed_metadata->>'archived_at', '') AS archived_at,
  NULLIF(ws.managed_metadata->>'archived_by', '') AS archived_by,
  NULLIF(ws.managed_metadata->>'archive_reason', '') AS archive_reason,
  ws.managed_metadata
FROM public.webhook_sources ws
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.senders snd ON snd.id = ws.sender_id
LEFT JOIN public.clients c ON c.id = snd.client_id
LEFT JOIN public.settings source_policy
  ON source_policy.category = 'webhook_ingest_policy'
 AND source_policy.scope_type = 'source'
 AND source_policy.scope_id = ws.id
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

GRANT SELECT ON public.v_webhook_source_directory TO authenticated, service_role;

COMMENT ON VIEW public.v_webhook_source_directory
  IS 'FE-friendly webhook source projection with sender/client binding, source health, token redaction, HMAC policy state, archive lifecycle metadata, and operator-facing mapping_label from mapping_config.label with mapping_key fallback. Mutations go through ui_upsert_webhook_source_v1 / ui_rotate_webhook_source_token_v1 / ui_archive_webhook_source_v1.';

COMMIT;
