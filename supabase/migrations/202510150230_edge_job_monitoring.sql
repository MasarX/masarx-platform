-- Migration: Edge job monitoring helpers
-- Purpose: Restore edge job health view and expired lease requeue function (Plan.md Section 5.7).
-- Date: 2025-10-15

BEGIN;

CREATE OR REPLACE VIEW edge_job_health AS
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
    oc.error_message
FROM outbound_calls oc
WHERE oc.status IN ('pending_edge', 'in_progress_edge');

COMMENT ON VIEW edge_job_health
    IS 'Realtime snapshot of outbound_calls queued for edge execution with derived queue and lease metrics.';

CREATE OR REPLACE FUNCTION requeue_expired_edge_jobs(p_limit INT DEFAULT 100)
RETURNS TABLE(job_id UUID, previous_status TEXT, lease_expires_at TIMESTAMPTZ, retry_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_record RECORD;
    v_org_id UUID;
BEGIN
    FOR v_record IN
        SELECT oc.*
        FROM outbound_calls oc
        WHERE oc.status = 'in_progress_edge'
          AND oc.lease_expires_at IS NOT NULL
          AND oc.lease_expires_at < now()
        ORDER BY oc.lease_expires_at
        LIMIT GREATEST(COALESCE(p_limit, 100), 1)
        FOR UPDATE SKIP LOCKED
    LOOP
        v_org_id := resolve_organization_id_strict('outbound_call', v_record.id);

        UPDATE outbound_calls
        SET status = 'pending_edge',
            lease_expires_at = NULL,
            scheduled_at = now()
        WHERE id = v_record.id;

        PERFORM log_decision(
            p_organization_id := v_org_id,
            p_decision_category := 'edge_dispatch',
            p_resource_type := 'outbound_call',
            p_resource_id := v_record.id,
            p_decision_point := 'requeue_expired_edge_jobs',
            p_decision_outcome := 'requeued',
            p_performed_by_system := 'requeue_expired_edge_jobs',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_build_object(
                'previous_status', v_record.status,
                'retry_count', v_record.retry_count,
                'max_retries', v_record.max_retries,
                'lease_expires_at', v_record.lease_expires_at
            ),
            p_decision_reason := 'Edge lease expired; job returned to pending_edge queue.'
        );

        job_id := v_record.id;
        previous_status := v_record.status;
        lease_expires_at := v_record.lease_expires_at;
        retry_count := v_record.retry_count;
        RETURN NEXT;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION requeue_expired_edge_jobs(INT)
    IS 'Return expired in_progress_edge jobs to pending_edge and emit decision log entries.';

COMMIT;


