-- Migration: Refresh comms reply observability views (correct timestamp column) and failures view
-- Date: 2025-12-01

BEGIN;

-- NOTE: Postgres CREATE OR REPLACE VIEW cannot drop/reorder existing columns.
-- Keep the original column order and append any newer columns at the end so
-- this migration is safe to apply even when newer view versions already exist.

CREATE OR REPLACE VIEW public.comms_reply_events_v AS
SELECT
    dl.id AS decision_id,
    dl.timestamp AS decision_time,
    dl.organization_id,
    wi.id AS webhook_id,
    wi.webhook_source_id,
    wi.provider_type,
    dl.correlation_id,
    dl.decision_outcome,
    dl.decision_reason AS error,
    dl.decision_inputs->>'intent' AS intent,
    dl.decision_inputs->>'recipient' AS recipient,
    dl.decision_inputs->>'message' AS reply_message,
    COALESCE(oc.response_status_code::TEXT, dl.decision_inputs->>'api_status') AS api_status,
    CASE
      WHEN oc.response_status_code BETWEEN 200 AND 299 THEN TRUE
      WHEN oc.response_status_code IS NULL THEN (dl.decision_inputs->>'sent')::BOOLEAN
      ELSE FALSE
    END AS sent,
    dl.decision_inputs AS decision_inputs,
    wi.raw_payload,
    wi.transformed_payload,
    -- queue-aware columns (appended)
    (dl.decision_inputs->>'dry_run')::BOOLEAN AS dry_run,
    (dl.decision_inputs->>'queued')::BOOLEAN AS queued,
    NULLIF(dl.decision_inputs->>'outbound_call_id', '')::UUID AS outbound_call_id,
    oc.status AS outbound_status,
    oc.response_status_code AS outbound_response_status_code,
    oc.error_message AS outbound_error_message,
    oc.completed_at AS outbound_completed_at
FROM decision_log dl
JOIN webhook_inbox wi
  ON wi.id = dl.resource_id
LEFT JOIN outbound_calls oc
  ON oc.id = NULLIF(dl.decision_inputs->>'outbound_call_id', '')::UUID
WHERE dl.decision_category = 'communication_reply';

COMMENT ON VIEW public.comms_reply_events_v IS 'Observability view for auto-replies (Dialog360), showing intent, queue state, outbound_call linkage, and delivery status.';

CREATE OR REPLACE VIEW public.comms_reply_failures_v AS
SELECT
  decision_id,
  decision_time,
  organization_id,
  webhook_id,
  webhook_source_id,
  provider_type,
  intent,
  recipient,
  reply_message,
  api_status,
  sent,
  error,
  decision_inputs,
  raw_payload,
  transformed_payload,
  -- appended
  dry_run,
  queued,
  outbound_call_id,
  outbound_status,
  outbound_response_status_code,
  outbound_error_message,
  outbound_completed_at
FROM public.comms_reply_events_v
WHERE error IS NOT NULL
   OR (
     outbound_call_id IS NOT NULL
     AND (
       outbound_status IN ('failed', 'permanently_failed')
       OR (outbound_response_status_code IS NOT NULL AND (outbound_response_status_code < 200 OR outbound_response_status_code >= 300))
     )
   )
   OR (
     outbound_call_id IS NULL
     AND COALESCE(dry_run, FALSE) = FALSE
     AND (
       COALESCE(sent, FALSE) = FALSE
       OR (api_status IS NOT NULL AND (api_status::INT < 200 OR api_status::INT >= 300))
     )
   );

COMMENT ON VIEW public.comms_reply_failures_v IS 'Filtered view of auto-reply events that failed to queue or were delivered with error (outbound failed/permanent_failed, non-2xx, or error).';

COMMIT;
