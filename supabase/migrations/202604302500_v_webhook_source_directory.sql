-- Spec-Issue: W27 INTEGRATIONS gap closure (paired projection views)
-- Step: W27-VIEW-1
-- Migration: Canonical projection view public.v_webhook_source_directory.
-- Capability: webhooks.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-source derived joins + counters used by
--   `apps/console-v2/src/modules/integrations/sources.tsx` (WebhookSourceRow):
--     - last_event_at        : derived MAX(webhook_inbox.created_at) per source
--     - last_event_status    : derived processing_status of MAX(created_at) row
--     - error_count_24h      : derived COUNT of webhook_inbox rows with
--                                processing_status IN ('failed','dead_letter')
--                                in the last 24h per source
--     - event_count_24h      : derived COUNT of webhook_inbox rows in the last
--                                24h per source
--     - rule_count           : derived COUNT(webhook_rules) per source
--     - active_rule_count    : derived COUNT(webhook_rules WHERE enabled=true)
--                                per source
--     - mapping_label        : derived from mapping_configs.mapping_key
--     - is_healthy           : derived flag (no errors in last 24h, enabled=true)
--     - has_recent_errors    : derived flag (error_count_24h > 0)
--     - auth_token_masked    : derived projection of auth_token (first 4 chars
--                                + '••••') for FE display safety
--
--   The FE `WebhookSourceRow` interface at
--   apps/console-v2/src/modules/integrations/sources.tsx carries:
--     - last_event_at as the only derived field (W18-4 projection annotation)
--   This view exposes the projection over the canonical SSOT.
--
-- Notes:
--   * SSOT remains public.webhook_sources; this view is read-only.
--   * RLS is enforced by the underlying tables (webhook_sources / webhook_inbox /
--     webhook_rules / mapping_configs) via `security_invoker = true`.
--   * Service-role + authenticated SELECT.
--   * Idempotent: pure view; safe to re-run.
--   * `error_count_24h` / `event_count_24h` evaluate `now()` at query time.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302500_v_webhook_source_directory'));
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
  -- Derived: mapping label resolution
  mc.mapping_key AS mapping_label,
  -- Derived: last event timing + status
  inbox_agg.last_event_at,
  inbox_agg.last_event_status,
  -- Derived: rolling 24h counters (now-aware)
  COALESCE(inbox_agg.event_count_24h, 0) AS event_count_24h,
  COALESCE(inbox_agg.error_count_24h, 0) AS error_count_24h,
  -- Derived: rule counts
  COALESCE(rule_agg.rule_count, 0) AS rule_count,
  COALESCE(rule_agg.active_rule_count, 0) AS active_rule_count,
  -- Derived: status flags (single SSOT for FE chip rendering)
  (ws.enabled = TRUE AND COALESCE(inbox_agg.error_count_24h, 0) = 0) AS is_healthy,
  (COALESCE(inbox_agg.error_count_24h, 0) > 0) AS has_recent_errors,
  -- Derived: masked token for safe display
  CASE
    WHEN ws.auth_token IS NULL THEN NULL
    WHEN length(ws.auth_token) <= 4 THEN '••••'
    ELSE substring(ws.auth_token FROM 1 FOR 4) || '••••'
  END AS auth_token_masked
FROM public.webhook_sources ws
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN LATERAL (
  SELECT
    MAX(wi.created_at) AS last_event_at,
    -- Pick the processing_status of the most-recent event via DISTINCT ON
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
  'FE-friendly projection of webhook_sources with derived counters (event_count_24h, error_count_24h, rule_count, active_rule_count), last-event timing + status (last_event_at, last_event_status), mapping label resolution (mapping_label via mapping_configs), and computed flags (is_healthy, has_recent_errors). Includes a masked auth_token projection (first 4 chars + ••••) for safe FE display. Sources: webhook_sources + webhook_inbox + webhook_rules + mapping_configs. Read-only; SSOT remains webhook_sources; mutations go through ui_upsert_webhook_source_v1 / ui_rotate_webhook_source_token_v1.';

REVOKE ALL ON public.v_webhook_source_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_source_directory FROM anon;
GRANT SELECT ON public.v_webhook_source_directory TO authenticated;
GRANT SELECT ON public.v_webhook_source_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302500_v_webhook_source_directory'));
COMMIT;
