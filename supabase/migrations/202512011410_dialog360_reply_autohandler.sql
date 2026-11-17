-- Migration: Automatically handle Dialog360 reply webhooks by invoking reply handler
-- Purpose: Apply mapping_config transforms to webhook payload and call worker_action_mark_communication_reply
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE FUNCTION public.process_dialog360_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_source RECORD;
    v_transformed JSONB;
    v_comm JSONB;
BEGIN
    SELECT source_identifier, mapping_config_id
    INTO v_source
    FROM webhook_sources
    WHERE id = NEW.webhook_source_id;

    IF NOT FOUND OR v_source.source_identifier <> 'dialog360_reply' THEN
        RETURN NEW;
    END IF;

    -- Apply mapping_config (supports transforms) to extract communication object.
    v_transformed := public.apply_mapping_config(NEW.raw_payload, v_source.mapping_config_id);
    v_comm := COALESCE(v_transformed->'communication', '{}'::jsonb);

    -- Fallback: if mapping yielded empty object, derive recipient/message_id/text from common Meta payload shape.
    IF v_comm = '{}'::jsonb THEN
        v_comm := jsonb_build_object(
            'recipient', NEW.raw_payload #>> '{entry,0,changes,0,value,contacts,0,wa_id}',
            'message_id', NEW.raw_payload #>> '{entry,0,changes,0,value,messages,0,id}',
            'reply_text', NEW.raw_payload #>> '{entry,0,changes,0,value,messages,0,text,body}',
            'timestamp', NEW.raw_payload #>> '{entry,0,changes,0,value,messages,0,timestamp}'
        );
    END IF;

    -- Persist transformed_payload for observability/troubleshooting
    UPDATE webhook_inbox
    SET transformed_payload = COALESCE(v_transformed, '{}'::jsonb)
    WHERE id = NEW.id;

    PERFORM worker_action_mark_communication_reply(
        NEW.id,
        jsonb_build_object('stop_reason', 'reply_received'),
        jsonb_build_object('transformed_payload', jsonb_build_object('communication', v_comm))
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dialog360_reply_autohandler ON webhook_inbox;

CREATE TRIGGER trg_dialog360_reply_autohandler
AFTER INSERT ON webhook_inbox
FOR EACH ROW
WHEN (NEW.webhook_source_id IS NOT NULL)
EXECUTE FUNCTION public.process_dialog360_reply();

COMMIT;
