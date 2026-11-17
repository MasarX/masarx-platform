-- Migration: Comms reply latency view (lightweight observability)
-- Purpose:
--   - Provide a single view to monitor reply end-to-end latency (webhook -> outbound completion).
--   - Support dashboards/alerts without duplicating logic in application code.
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE VIEW public.comms_reply_latency_v AS
SELECT
  e.decision_id,
  e.decision_time,
  e.organization_id,
  e.webhook_id,
  wi.created_at AS webhook_created_at,
  e.webhook_source_id,
  e.intent,
  e.recipient,
  e.queued,
  e.outbound_call_id,
  oc.created_at AS outbound_created_at,
  e.outbound_status,
  e.outbound_response_status_code,
  e.outbound_error_message,
  e.outbound_completed_at,
  CASE
    WHEN e.outbound_completed_at IS NULL THEN NULL
    ELSE round(extract(epoch from (e.outbound_completed_at - wi.created_at)) * 1000.0)::INT
  END AS end_to_end_latency_ms,
  CASE
    WHEN e.outbound_completed_at IS NULL OR oc.created_at IS NULL THEN NULL
    ELSE round(extract(epoch from (e.outbound_completed_at - oc.created_at)) * 1000.0)::INT
  END AS outbound_execution_latency_ms
FROM public.comms_reply_events_v e
JOIN public.webhook_inbox wi
  ON wi.id = e.webhook_id
LEFT JOIN public.outbound_calls oc
  ON oc.id = e.outbound_call_id;

COMMENT ON VIEW public.comms_reply_latency_v
  IS 'Comms reply latency view: webhook created_at to outbound completion (ms) + outbound execution duration.';

COMMIT;

