-- Migration: Label renderer cron guard
-- Purpose: Align cron_config and scheduling state with invoke configuration:
--          keep job disabled when placeholders are active, otherwise ensure it
--          remains scheduled/enabled.

BEGIN;

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
        ELSE
            v_placeholder := TRUE;
        END IF;
    ELSE
        v_placeholder := TRUE;
    END IF;

    IF v_placeholder THEN
        UPDATE cron_config
        SET enabled = FALSE,
            notes = 'Auto-dispatch label renderer via invoke_label_renderer(); enable after invoke_url/invoke_secret rotated'
        WHERE worker_name = 'label_job_renderer';

        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'label_renderer_dispatch') THEN
            PERFORM cron.unschedule('label_renderer_dispatch');
        END IF;

        RAISE NOTICE 'label_renderer_dispatch unscheduled; rotate label_provider invoke configuration before enabling.';
    ELSE
        UPDATE cron_config
        SET enabled = TRUE,
            notes = 'Auto-dispatch label renderer via invoke_label_renderer(); enabled (invoke configuration present)'
        WHERE worker_name = 'label_job_renderer';

        IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'label_renderer_dispatch') THEN
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
        END IF;
    END IF;
END;
$$;

COMMIT;
