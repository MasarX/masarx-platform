-- Plan: PLAN-202512-logging-prod-ready-ssot-alert-delivery-v1 / Step: S02
-- Migration: Alert delivery status view (authoritative from outbound_calls execution)
-- Purpose: Provide a single, queryable surface for 2AM debugging:
--          alert_trigger -> intended channels -> latest outbound_call attempt -> delivery status.

BEGIN;

-- Performance: make correlation from alert_trigger -> outbound_calls cheap.
CREATE INDEX IF NOT EXISTS idx_outbound_calls_ctx_alert_trigger_id
  ON public.outbound_calls ((context->>'alert_trigger_id'))
  WHERE context ? 'alert_trigger_id';

CREATE INDEX IF NOT EXISTS idx_outbound_calls_ctx_alert_channel
  ON public.outbound_calls ((context->>'channel'))
  WHERE context ? 'channel';

DROP VIEW IF EXISTS public.alert_delivery_status_v;

CREATE OR REPLACE VIEW public.alert_delivery_status_v AS
WITH base AS (
  SELECT
    at.id AS alert_trigger_id,
    at.organization_id,
    at.alert_rule_id,
    ar.rule_name,
    at.severity,
    at.message,
    at.context AS trigger_context,
    at.notified_at,
    at."timestamp" AS triggered_at,
    COALESCE(
      CASE WHEN jsonb_typeof(at.context->'alert_channels') = 'array' THEN at.context->'alert_channels' END,
      CASE WHEN jsonb_typeof(ar.alert_channels) = 'array' THEN ar.alert_channels END,
      '[]'::jsonb
    ) AS channels_json,
    CASE
      WHEN at.context ? 'correlation_id'
        AND (at.context->>'correlation_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (at.context->>'correlation_id')::uuid
      ELSE NULL
    END AS correlation_id
  FROM public.alert_triggers at
  JOIN public.alert_rules ar ON ar.id = at.alert_rule_id
)
SELECT
  b.alert_trigger_id,
  b.organization_id,
  b.alert_rule_id,
  b.rule_name,
  b.severity,
  b.message,
  b.triggered_at,
  b.notified_at,
  b.correlation_id,
  ch.channel,
  oc.id AS outbound_call_id,
  oc.status AS outbound_status,
  oc.response_status_code,
  oc.error_message,
  oc.latency_ms,
  oc.created_at AS enqueued_at,
  oc.completed_at,
  CASE
    WHEN oc.id IS NULL THEN 'not_enqueued'
    WHEN oc.status = 'completed' AND COALESCE(oc.response_status_code, 0) BETWEEN 200 AND 299 THEN 'delivered'
    WHEN oc.status = 'completed' THEN 'failed'
    WHEN oc.status IN ('failed', 'permanently_failed') THEN 'failed'
    ELSE oc.status
  END AS delivery_status,
  jsonb_strip_nulls(jsonb_build_object(
    'trigger_context', b.trigger_context,
    'dispatch_context', oc.context,
    'response_headers', oc.response_headers,
    'response_body', oc.response_body
  )) AS metadata
FROM base b
LEFT JOIN LATERAL (
  SELECT LOWER(value) AS channel
  FROM jsonb_array_elements_text(b.channels_json) a(value)
) ch ON TRUE
LEFT JOIN LATERAL (
  SELECT oc.*
  FROM public.outbound_calls oc
  WHERE oc.context->>'alert_trigger_id' = b.alert_trigger_id::text
    AND LOWER(COALESCE(oc.context->>'channel', '')) = COALESCE(ch.channel, '')
  ORDER BY oc.created_at DESC
  LIMIT 1
) oc ON TRUE;

COMMENT ON VIEW public.alert_delivery_status_v IS
  'Alert delivery status surface: per alert_trigger + channel shows latest outbound_calls attempt and derived delivery_status.';

REVOKE ALL ON public.alert_delivery_status_v FROM PUBLIC;
REVOKE ALL ON public.alert_delivery_status_v FROM anon;
REVOKE ALL ON public.alert_delivery_status_v FROM authenticated;
GRANT SELECT ON public.alert_delivery_status_v TO service_role;

COMMIT;

