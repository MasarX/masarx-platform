-- Migration: Backfill reply handling when workflow run is created after inbound webhook
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE FUNCTION public.process_workflow_run_comm_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_comm JSONB := COALESCE(NEW.context->'communication', '{}'::jsonb);
    v_recipient TEXT := NULLIF(v_comm->>'recipient', '');
    v_message_id TEXT := NULLIF(v_comm->>'message_id', '');
    v_webhook RECORD;
    v_transformed JSONB;
    v_source RECORD;
BEGIN
    IF v_recipient IS NULL AND v_message_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Find the latest dialog360_reply webhook for the same recipient/message_id.
    SELECT wi.*, ws.mapping_config_id
    INTO v_webhook
    FROM webhook_inbox wi
    JOIN webhook_sources ws ON ws.id = wi.webhook_source_id
    WHERE ws.source_identifier = 'dialog360_reply'
      AND (
        (wi.raw_payload #>> '{entry,0,changes,0,value,contacts,0,wa_id}' = v_recipient)
        OR (wi.raw_payload #>> '{entry,0,changes,0,value,messages,0,id}' = v_message_id)
        OR (wi.transformed_payload #>> '{communication,recipient}' = v_recipient)
        OR (wi.transformed_payload #>> '{communication,message_id}' = v_message_id)
      )
    ORDER BY wi.created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    v_transformed := COALESCE(
        v_webhook.transformed_payload,
        public.apply_mapping_config(v_webhook.raw_payload, v_webhook.mapping_config_id)
    );

    PERFORM worker_action_mark_communication_reply(
        v_webhook.id,
        jsonb_build_object('stop_reason','reply_received'),
        jsonb_build_object('transformed_payload', v_transformed)
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_run_comm_reply ON workflow_runs;

CREATE TRIGGER trg_workflow_run_comm_reply
AFTER INSERT ON workflow_runs
FOR EACH ROW
WHEN (NEW.context ? 'communication')
EXECUTE FUNCTION public.process_workflow_run_comm_reply();

COMMIT;
