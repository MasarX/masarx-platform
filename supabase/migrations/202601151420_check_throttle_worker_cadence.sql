-- Migration: check_throttle worker cadence overrides
-- Purpose:
--   - Apply worker_cadence settings (row-driven) before throttle checks.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
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
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_config RECORD;
    v_force TEXT := NULL;
    v_policy_row RECORD;
    v_policy JSONB := NULL;
    v_worker JSONB := NULL;
    v_override_interval INT := NULL;
    v_override_batch INT := NULL;
    v_policy_ctx JSONB := '{}'::jsonb;
BEGIN
    SELECT c.worker_name, c.interval_seconds, c.batch_size, c.last_run_at, c.enabled
      INTO v_config
      FROM cron_config c
     WHERE worker_name = p_worker_name;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Worker not registered in cron_config', 0, 0;
        RETURN;
    END IF;

    BEGIN
      v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', NULLIF(current_setting('app.organization_id', true), ''),
        'tenant_id', NULLIF(current_setting('app.tenant_id', true), ''),
        'client_id', NULLIF(current_setting('app.client_id', true), ''),
        'sender_id', NULLIF(current_setting('app.sender_id', true), '')
      ));
    EXCEPTION
      WHEN others THEN
        v_policy_ctx := '{}'::jsonb;
    END;

    IF v_policy_ctx <> '{}'::jsonb THEN
      SELECT *
        INTO v_policy_row
        FROM public.resolve_settings_row_from_context('worker_cadence', v_policy_ctx)
       LIMIT 1;
      v_policy := v_policy_row.value;
    END IF;

    IF v_policy IS NULL THEN
      v_policy := public.resolve_settings('worker_cadence', 'global', NULL);
    END IF;

    IF v_policy ? 'workers' AND (v_policy->'workers' ? p_worker_name) THEN
      v_worker := v_policy->'workers'->p_worker_name;

      BEGIN
        v_override_interval := NULLIF(v_worker->>'interval_seconds', '')::INT;
      EXCEPTION
        WHEN others THEN
          v_override_interval := NULL;
      END;

      IF v_override_interval IS NOT NULL AND v_override_interval > 0 THEN
        v_config.interval_seconds := v_override_interval;
      END IF;

      BEGIN
        v_override_batch := NULLIF(v_worker->>'batch_size', '')::INT;
      EXCEPTION
        WHEN others THEN
          v_override_batch := NULL;
      END;

      IF v_override_batch IS NOT NULL AND v_override_batch > 0 THEN
        v_config.batch_size := v_override_batch;
      END IF;
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
    IS 'Consult cron_config for worker cadence and determine if worker should run (supports forced inline runs + worker_cadence overrides).';

COMMIT;
