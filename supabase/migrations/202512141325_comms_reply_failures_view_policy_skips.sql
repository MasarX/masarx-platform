-- Migration: Refine comms_reply_failures_v to exclude policy-driven skips
-- Purpose:
--   - Avoid alert noise for expected policy outcomes (e.g., recipient_opted_out, rate_limited).
--   - Keep failure view focused on actionable delivery/queue errors.
-- Date: 2025-12-14

BEGIN;

-- Keep original column order; only refine filtering criteria.
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
  -- appended (queue-aware)
  dry_run,
  queued,
  outbound_call_id,
  outbound_status,
  outbound_response_status_code,
  outbound_error_message,
  outbound_completed_at
FROM public.comms_reply_events_v
WHERE (
    error IS NOT NULL
    AND error NOT IN ('recipient_opted_out', 'rate_limited')
  )
  OR (
    outbound_call_id IS NOT NULL
    AND (
      outbound_status IN ('failed', 'permanently_failed')
      OR (
        outbound_response_status_code IS NOT NULL
        AND (outbound_response_status_code < 200 OR outbound_response_status_code >= 300)
      )
    )
  )
  OR (
    outbound_call_id IS NULL
    AND COALESCE(dry_run, FALSE) = FALSE
    AND error IS NULL
    AND (
      COALESCE(sent, FALSE) = FALSE
      OR (api_status IS NOT NULL AND (api_status::INT < 200 OR api_status::INT >= 300))
    )
  );

COMMENT ON VIEW public.comms_reply_failures_v
  IS 'Filtered view of auto-reply events that failed to queue or were delivered with error; excludes policy-driven skips (recipient_opted_out, rate_limited).';

COMMIT;

