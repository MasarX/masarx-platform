-- Migration: Non-engine outbound calls guardrail
-- Purpose: Provide visibility into outbound_calls rows missing workflow linkage.
-- Date: 2025-11-14

BEGIN;

CREATE OR REPLACE VIEW public.non_engine_outbound_calls_v AS
SELECT
    oc.id,
    oc.call_type,
    oc.target_type,
    oc.target_id,
    oc.status,
    oc.priority,
    oc.retry_count,
    oc.max_retries,
    oc.scheduled_at,
    oc.created_at,
    oc.completed_at,
    oc.correlation_id,
    oc.context,
    oc.workflow_run_step_id,
    oc.response_status_code,
    oc.error_message
FROM outbound_calls oc
WHERE oc.workflow_run_step_id IS NULL;

COMMENT ON VIEW public.non_engine_outbound_calls_v
    IS 'Lists outbound_calls rows that are not linked to workflow_run_steps. Used for migration guardrails.';

COMMIT;
