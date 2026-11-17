-- Migration: Edge job health view includes retries + due metrics
-- Purpose:
--   - Extend edge_job_health to include retry-scheduled failures (status=failed).
--   - Make scheduled_at semantics observable: due_in_seconds + overdue_seconds.
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE VIEW public.edge_job_health AS
SELECT
    oc.id AS job_id,
    oc.status,
    oc.call_type,
    oc.target_type,
    oc.target_id,
    oc.priority,
    oc.retry_count,
    oc.max_retries,
    GREATEST(oc.max_retries - oc.retry_count, 0) AS remaining_attempts,
    oc.scheduled_at,
    oc.lease_expires_at,
    oc.created_at,
    oc.completed_at,
    EXTRACT(EPOCH FROM (now() - oc.scheduled_at))::INT AS queue_age_seconds,
    CASE
        WHEN oc.lease_expires_at IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (now() - oc.lease_expires_at))::INT
    END AS lease_overdue_seconds,
    (oc.lease_expires_at IS NOT NULL AND oc.lease_expires_at < now()) AS lease_overdue,
    NULLIF(oc.context->'edge_dispatch'->>'timeout_seconds', '')::INT AS timeout_seconds,
    COALESCE(oc.context->'edge_dispatch', '{}'::jsonb) AS edge_dispatch_context,
    oc.error_message,
    GREATEST(EXTRACT(EPOCH FROM (oc.scheduled_at - now())), 0)::INT AS due_in_seconds,
    GREATEST(EXTRACT(EPOCH FROM (now() - oc.scheduled_at)), 0)::INT AS overdue_seconds
FROM public.outbound_calls oc
WHERE oc.status IN ('pending_edge', 'in_progress_edge', 'failed');

COMMENT ON VIEW public.edge_job_health
    IS 'Realtime snapshot of outbound_calls eligible for edge execution (pending_edge/in_progress_edge) plus retry-scheduled failures (failed), with due/overdue metrics derived from scheduled_at.';

COMMIT;
