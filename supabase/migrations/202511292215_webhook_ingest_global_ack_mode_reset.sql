-- Migration: Reset global webhook_ingest_policy ACK mode to accepted_async
-- Purpose: ensure global ack configuration matches async baseline (mode=accepted_async, status_code=202) for ingest workflows.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
    v_sv UUID;
BEGIN
    SELECT sv.id
      INTO v_sv
      FROM settings_versions sv
      JOIN settings s ON s.settings_version_id = sv.id
     WHERE s.category = 'webhook_ingest_policy'
       AND s.scope_type = 'global'
     ORDER BY s.last_updated DESC
     LIMIT 1;

    IF v_sv IS NOT NULL THEN
        UPDATE settings_versions sv
           SET value = jsonb_set(
                         jsonb_set(value, '{ack,mode}', to_jsonb('accepted_async'::TEXT), true),
                         '{ack,status_code}',
                         to_jsonb(202),
                         true
                       )
         WHERE sv.id = v_sv;

        UPDATE settings s
           SET cached_value = sv.value,
               last_updated = now()
          FROM settings_versions sv
         WHERE s.settings_version_id = sv.id
           AND s.category = 'webhook_ingest_policy'
           AND s.scope_type = 'global';
    END IF;
END $$;

COMMIT;

