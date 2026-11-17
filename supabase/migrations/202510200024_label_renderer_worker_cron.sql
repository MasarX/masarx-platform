-- Migration: Label renderer worker + cron wiring
-- Purpose: Register the label_job_renderer worker, align cron throttles, and
--          schedule pg_cron to execute invoke_label_renderer() on cadence.
-- Compliance: ZERO HARD CODING (config rows drive behaviour), SIMPLE/SCALABLE
--             (batch-driven max_jobs), COMPLETE (idempotent inserts + cron reset).

BEGIN;

INSERT INTO worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
    'label_job_renderer',
    'workflow',
    'Invokes the label-renderer edge function to process pending label jobs',
    '*/1 * * * *',
    '{
        "max_jobs": 10,
        "lease_seconds": 300,
        "timeout_seconds": 20,
        "notes": "invoke_label_renderer() posts to the configured label provider endpoint"
    }'::jsonb,
    TRUE
)
ON CONFLICT (worker_name) DO UPDATE
SET
    worker_type = EXCLUDED.worker_type,
    description = EXCLUDED.description,
    schedule = EXCLUDED.schedule,
    config = EXCLUDED.config,
    is_active = EXCLUDED.is_active,
    updated_at = now();

INSERT INTO cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
    'label_job_renderer',
    60,
    10,
    FALSE,
    'Auto-dispatch label renderer via invoke_label_renderer(); enable after invoke_url/invoke_secret rotated'
)
ON CONFLICT (worker_name) DO UPDATE
SET
    interval_seconds = EXCLUDED.interval_seconds,
    batch_size = EXCLUDED.batch_size,
    enabled = EXCLUDED.enabled,
    notes = EXCLUDED.notes,
    last_run_at = cron_config.last_run_at;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'label_renderer_dispatch') THEN
        PERFORM cron.unschedule('label_renderer_dispatch');
    END IF;
END;
$$;

DO $$
DECLARE
    v_config JSONB;
    v_provider JSONB;
    v_placeholder BOOLEAN := FALSE;
BEGIN
    SELECT cached_value
    INTO v_config
    FROM settings
    WHERE category = 'label_provider'
      AND scope_type = 'global'
    ORDER BY last_updated DESC
    LIMIT 1;

    IF v_config IS NOT NULL THEN
        v_provider := v_config->'providers'->0;
        IF v_provider IS NOT NULL THEN
            v_placeholder := (v_provider->>'invoke_url' IS NULL OR v_provider->>'invoke_url' = 'https://example.supabase.co/functions/v1/label-renderer' /* objectives:allow SUPABASE_URL Justification: placeholder sentinel, not an actual endpoint */ )
                OR (v_provider->>'invoke_secret' IS NULL OR v_provider->>'invoke_secret' = 'EXAMPLE_PASSWORD');
        END IF;
    ELSE
        v_placeholder := TRUE;
    END IF;

    IF v_placeholder THEN
        RAISE NOTICE 'label_renderer_dispatch not scheduled (rotate label_provider invoke configuration before enabling)';
    ELSE
        PERFORM cron.schedule(
            'label_renderer_dispatch',
            '*/1 * * * *',
            format(
                'SELECT invoke_label_renderer(%s);',
                COALESCE(
                    (SELECT batch_size FROM cron_config WHERE worker_name = 'label_job_renderer'),
                    10
                )
            )
        );

        UPDATE cron_config
        SET enabled = TRUE
        WHERE worker_name = 'label_job_renderer';
    END IF;
END;
$$;

COMMIT;
