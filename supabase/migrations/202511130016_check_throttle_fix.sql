-- Migration: check_throttle qualification fix
-- Purpose: Qualify cron_config to avoid search_path ambiguity

BEGIN;

CREATE OR REPLACE FUNCTION public.check_throttle(
    p_worker_name TEXT
)
RETURNS TABLE (
    should_run BOOLEAN,
    reason TEXT,
    batch_size INT,
    interval_seconds_config INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, pg_temp'
AS $$
DECLARE
    v_config RECORD;
BEGIN
    SELECT c.worker_name, c.interval_seconds, c.batch_size, c.last_run_at, c.enabled
    INTO v_config
    FROM public.cron_config c
    WHERE worker_name = p_worker_name;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Worker not registered in cron_config', 0, 0;
        RETURN;
    END IF;

    IF NOT v_config.enabled THEN
        RETURN QUERY SELECT FALSE, 'Worker disabled in cron_config', 0, v_config.interval_seconds;
        RETURN;
    END IF;

    IF v_config.last_run_at IS NOT NULL
       AND v_config.last_run_at + make_interval(secs => v_config.interval_seconds) > now() THEN
        RETURN QUERY SELECT FALSE, 'Throttled: interval not elapsed', v_config.batch_size, v_config.interval_seconds;
        RETURN;
    END IF;

    RETURN QUERY SELECT TRUE, 'ready', v_config.batch_size, v_config.interval_seconds;
END;
$$;

COMMIT;

