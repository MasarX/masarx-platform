-- Migration: orchestrate_webhook_processing qualification fix

BEGIN;

CREATE OR REPLACE FUNCTION public.orchestrate_webhook_processing(p_webhook_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public, pg_temp'
AS $$
DECLARE
    v_webhook RECORD;
    v_source RECORD;
    v_transformed_payload JSONB;
BEGIN
    SELECT * INTO v_webhook FROM public.webhook_inbox WHERE id = p_webhook_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Webhook % not found', p_webhook_id;
    END IF;

    SELECT * INTO v_source FROM public.webhook_sources WHERE id = v_webhook.webhook_source_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Webhook source % not found for webhook %', v_webhook.webhook_source_id, p_webhook_id;
    END IF;

    IF v_webhook.transformed_payload IS NOT NULL THEN
        v_transformed_payload := v_webhook.transformed_payload;
    ELSE
        v_transformed_payload := public.apply_mapping_config(
            v_webhook.raw_payload,
            v_source.mapping_config_id
        );
    END IF;

    UPDATE public.webhook_inbox
    SET transformed_payload = v_transformed_payload,
        processing_status = 'succeeded',
        processed_at = now()
    WHERE id = p_webhook_id;

    v_webhook.transformed_payload := v_transformed_payload;

    RETURN jsonb_build_object(
        'status', 'succeeded',
        'webhook_id', p_webhook_id,
        'organization_id', v_source.organization_id,
        'transformed_payload', v_transformed_payload,
        'webhook', to_jsonb(v_webhook),
        'workflow_followup_actions', COALESCE(v_webhook.workflow_followup_actions, '[]'::jsonb),
        'workflow_followup_workflow_id', v_webhook.workflow_followup_workflow_id,
        'workflow_followup_workflow_run_id', v_webhook.workflow_followup_workflow_run_id,
        'policy_settings_id', v_webhook.policy_settings_id,
        'policy_scope_type', v_webhook.policy_scope_type,
        'policy_scope_id', v_webhook.policy_scope_id,
        'policy_version', v_webhook.policy_version,
        'ack_outcome', v_webhook.ack_outcome,
        'ack_mode', v_webhook.ack_mode,
        'correlation_id', v_webhook.correlation_id
    );
END;
$$;

COMMIT;


