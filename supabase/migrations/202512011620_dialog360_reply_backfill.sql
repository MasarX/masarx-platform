-- Migration: Backfill Dialog360 reply webhooks with normalized mapping and replay handler
-- Date: 2025-12-01

BEGIN;

DO $$
DECLARE
    rec RECORD;
    v_transformed JSONB;
BEGIN
    FOR rec IN
        SELECT wi.id, wi.raw_payload, ws.mapping_config_id
        FROM webhook_inbox wi
        JOIN webhook_sources ws ON ws.id = wi.webhook_source_id
        WHERE ws.source_identifier = 'dialog360_reply'
          AND (
            wi.transformed_payload IS NULL
            OR wi.transformed_payload->'communication' IS NULL
            OR wi.transformed_payload->'communication' = '{}'::jsonb
          )
    LOOP
        v_transformed := public.apply_mapping_config(rec.raw_payload, rec.mapping_config_id);
        UPDATE webhook_inbox
        SET transformed_payload = v_transformed
        WHERE id = rec.id;

        PERFORM worker_action_mark_communication_reply(
            rec.id,
            jsonb_build_object('stop_reason','reply_received'),
            jsonb_build_object('transformed_payload', v_transformed)
        );
    END LOOP;
END
$$;

COMMIT;
