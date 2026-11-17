-- Migration: check_throttle forced override support
-- Purpose: Allow inline dispatch to bypass interval checks when forced via app.force_worker.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | ZERO HARD CODING.
-- Date: 2026-01-14
BEGIN;

CREATE OR REPLACE FUNCTION public.check_throttle(p_worker_name TEXT)
RETURNS TABLE (
    should_run BOOLEAN,
    reason TEXT,
    batch_size INT,
    interval_seconds_config INT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_config RECORD;
    v_force TEXT := NULL;
BEGIN
    SELECT c.worker_name, c.interval_seconds, c.batch_size, c.last_run_at, c.enabled
    INTO v_config
    FROM cron_config c
    WHERE worker_name = p_worker_name;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Worker not registered in cron_config', 0, 0;
        RETURN;
    END IF;

    IF NOT v_config.enabled THEN
        RETURN QUERY SELECT FALSE, 'Worker disabled in cron_config', 0, v_config.interval_seconds;
        RETURN;
    END IF;

    BEGIN
      v_force := current_setting('app.force_worker', true);
    EXCEPTION
      WHEN others THEN
        v_force := NULL;
    END;

    IF v_force IS NOT NULL AND btrim(v_force) <> '' AND v_force = p_worker_name THEN
        RETURN QUERY SELECT TRUE, 'forced', v_config.batch_size, v_config.interval_seconds;
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

COMMENT ON FUNCTION public.check_throttle(TEXT)
    IS 'Consult cron_config for worker cadence and determine if worker should run (supports forced inline runs).';

COMMIT;