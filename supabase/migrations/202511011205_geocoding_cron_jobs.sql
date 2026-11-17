-- Migration: Geocoding automation jobs
-- Purpose: Add scheduled maintenance for stuck geocoding steps, manual review escalation, and cache cleanup.
-- Alignment: SCALABLE - DYNAMIC - all behaviour driven by settings/policies; no hard-coded runtime branches.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.requeue_stuck_geocoding_steps(
    p_limit INT DEFAULT 500,
    p_timeout_seconds INT DEFAULT 300
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_timeout INTERVAL := make_interval(secs => GREATEST(COALESCE(p_timeout_seconds, 60), 60));
    v_requeued INT;
BEGIN
    WITH candidates AS (
        SELECT wrs.id
        FROM workflow_run_steps wrs
        JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
        JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
        WHERE wt.name LIKE 'workflow_geocoding%'
          AND wrs.operation_name IN ('dispatch_provider', 'fallback_provider')
          AND wrs.step_status = 'in_progress'
          AND wrs.operation_started_at IS NOT NULL
          AND wrs.operation_started_at <= now() - v_timeout
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE workflow_run_steps wrs
        SET step_status = 'pending',
            operation_started_at = NULL,
            operation_completed_at = NULL,
            run_at = now(),
            retry_attempt = LEAST(wrs.retry_attempt + 1, wrs.max_retries),
            last_error = 'reclaimed_by_geocoding_cron',
            updated_at = now()
        FROM candidates c
        WHERE wrs.id = c.id
        RETURNING wrs.workflow_run_id
    )
    UPDATE workflow_runs wr
    SET workflow_status = 'in_progress',
        updated_at = now()
    WHERE wr.id IN (SELECT workflow_run_id FROM updated);

    GET DIAGNOSTICS v_requeued = ROW_COUNT;
    RETURN COALESCE(v_requeued, 0);
END;
$$;

COMMENT ON FUNCTION public.requeue_stuck_geocoding_steps(INT, INT)
    IS 'Requeue provider dispatch steps that exceeded their in-progress timeout.';

CREATE OR REPLACE FUNCTION public.escalate_geocoding_manual_review(
    p_limit INT DEFAULT 200
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_updated INT;
BEGIN
    WITH due_tasks AS (
        SELECT id
        FROM manual_review_tasks
        WHERE task_type = 'geocoding'
          AND status = 'pending'
          AND sla_due_at IS NOT NULL
          AND sla_due_at < now()
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    escalated AS (
        UPDATE manual_review_tasks mrt
        SET status = 'escalated',
            queue_assignment = COALESCE(queue_assignment, 'geo_ops_on_call'),
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('escalated_at', now()),
            updated_at = now()
        FROM due_tasks dt
        WHERE mrt.id = dt.id
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_updated FROM escalated;

    RETURN COALESCE(v_updated, 0);
END;
$$;

COMMENT ON FUNCTION public.escalate_geocoding_manual_review(INT)
    IS 'Escalate geocoding manual review tasks whose SLA is breached.';

CREATE OR REPLACE FUNCTION public.cleanup_expired_geocodes(
    p_limit INT DEFAULT 1000
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deleted INT;
BEGIN
    WITH doomed AS (
        SELECT ctid
        FROM geocodes
        WHERE expires_at IS NOT NULL
          AND expires_at < now()
        LIMIT p_limit
    )
    DELETE FROM geocodes g
    USING doomed d
    WHERE g.ctid = d.ctid;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN COALESCE(v_deleted, 0);
END;
$$;

COMMENT ON FUNCTION public.cleanup_expired_geocodes(INT)
    IS 'Remove expired geocodes to keep cache lean.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'geocoding_reclaim_in_progress') THEN
        PERFORM cron.unschedule('geocoding_reclaim_in_progress');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'geocoding_manual_review_escalate') THEN
        PERFORM cron.unschedule('geocoding_manual_review_escalate');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'geocoding_cache_cleanup') THEN
        PERFORM cron.unschedule('geocoding_cache_cleanup');
    END IF;
END;
$$;

SELECT cron.schedule(
    'geocoding_reclaim_in_progress',
    '*/10 * * * *',
    $$SELECT requeue_stuck_geocoding_steps(500, 300);$$
);

SELECT cron.schedule(
    'geocoding_manual_review_escalate',
    '*/15 * * * *',
    $$SELECT escalate_geocoding_manual_review(200);$$
);

SELECT cron.schedule(
    'geocoding_cache_cleanup',
    '0 * * * *',
    $$SELECT cleanup_expired_geocodes(1000);$$
);

COMMIT;
