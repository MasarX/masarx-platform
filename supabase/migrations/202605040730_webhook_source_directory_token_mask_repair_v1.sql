-- Spec-Issue: W27 INTEGRATIONS projection repair
-- Step: W27-WEBHOOK-SOURCE-TOKEN-MASK-REPAIR-1
-- Migration: Keep auth_token_masked non-null when token hashing redacts auth_token.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031700_webhook_source_directory_token_mask_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  ws.auth_token,
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
    WHEN ws.auth_token IS NOT NULL AND length(ws.auth_token) <= 4 THEN 'stored'
    WHEN ws.auth_token IS NOT NULL THEN substring(ws.auth_token FROM 1 FOR 4) || '-stored'
    WHEN ws.auth_token_hash IS NOT NULL THEN 'stored'
    ELSE NULL
  END AS auth_token_masked
FROM public.webhook_sources ws
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
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
  'FE-friendly projection of webhook_sources with derived counters, last-event timing/status, mapping label, health flags, and a non-secret auth_token_masked marker. Raw tokens are redacted by trigger into auth_token_hash; this view never exposes token material.';

REVOKE ALL ON public.v_webhook_source_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_source_directory FROM anon;
GRANT SELECT ON public.v_webhook_source_directory TO authenticated;
GRANT SELECT ON public.v_webhook_source_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605031700_webhook_source_directory_token_mask_repair_v1'));
COMMIT;
