-- Migration: Observability view for Dialog360/communication replies
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE VIEW public.comms_reply_events_v AS
SELECT
    dl.id AS decision_id,
    dl.created_at AS decision_time,
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
    dl.decision_inputs->>'api_status' AS api_status,
    (dl.decision_inputs->>'sent')::BOOLEAN AS sent,
    dl.decision_inputs AS decision_inputs,
    wi.raw_payload,
    wi.transformed_payload
FROM decision_log dl
JOIN webhook_inbox wi
  ON wi.id = dl.resource_id
WHERE dl.decision_category = 'communication_reply';

COMMENT ON VIEW public.comms_reply_events_v IS 'Observability view for auto-replies (Dialog360), showing intent, send status, payload, and errors.';

COMMIT;
