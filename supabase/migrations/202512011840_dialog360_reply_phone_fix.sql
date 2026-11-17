-- Migration: Fix recipient phone column in send_comms_reply
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE FUNCTION public.send_comms_reply(
    p_webhook_id UUID,
    p_webhook_source_id UUID,
    p_comm JSONB,
    p_organization_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_policy JSONB;
    v_policy_scope TEXT := NULL;
    v_intents JSONB;
    v_reply_text TEXT := lower(COALESCE(p_comm->>'reply_text', ''));
    v_recipient TEXT := NULLIF(p_comm->>'recipient', '');
    v_message_id TEXT := NULLIF(p_comm->>'message_id', '');
    v_intent TEXT := 'fallback';
    v_template TEXT;
    v_not_found_template TEXT;
    v_message TEXT;
    v_eta TEXT;
    v_tracking TEXT;
    v_status TEXT;
    v_shipment RECORD;
    v_shipment_id UUID := NULL;
    v_api_key TEXT;
    v_auth_config_id UUID;
    v_dry_run BOOLEAN := FALSE;
    v_resp JSONB;
    v_sent BOOLEAN := FALSE;
    v_error TEXT := NULL;
    v_headers JSONB;
    v_body JSONB;
    v_decision_inputs JSONB;
    v_corr UUID := NULL;
BEGIN
    -- Resolve policy via ladder: resource -> tenant -> global.
    v_policy := resolve_settings('comms_reply_policy', 'resource', p_webhook_source_id);
    IF v_policy IS NULL AND p_organization_id IS NOT NULL THEN
        v_policy := resolve_settings('comms_reply_policy', 'tenant', p_organization_id);
    END IF;
    IF v_policy IS NULL THEN
        v_policy := resolve_settings('comms_reply_policy', 'global', NULL);
    END IF;

    IF v_policy IS NULL THEN
        RETURN jsonb_build_object('status', 'skipped', 'reason', 'policy_missing');
    END IF;

    v_policy_scope := COALESCE(v_policy->>'scope', v_policy_scope);
    v_auth_config_id := NULLIF(v_policy->>'auth_config_id', '')::UUID;
    v_intents := COALESCE(v_policy->'intents', '{}'::jsonb);
    v_dry_run := COALESCE((v_policy->>'dry_run')::BOOLEAN, FALSE);

    -- Determine intent via keyword match (policy-driven).
    FOR v_intent IN SELECT key
                    FROM jsonb_object_keys(v_intents) AS key
                    WHERE key <> 'fallback'
    LOOP
        IF EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(v_intents->v_intent->'keywords', '[]'::jsonb)) AS kw
            WHERE v_reply_text LIKE '%' || lower(kw) || '%'
        ) THEN
            EXIT;
        END IF;
        v_intent := 'fallback';
    END LOOP;

    -- Load shipment context when required.
    IF v_intent IN ('status', 'eta') AND v_recipient IS NOT NULL THEN
        SELECT s.id,
               s.tracking_number,
               s.status,
               s.promised_delivery_date
          INTO v_shipment
          FROM shipments s
          JOIN recipients r ON r.id = s.recipient_id
         WHERE r.phone_number = v_recipient
         ORDER BY s.created_at DESC
         LIMIT 1;

        IF FOUND THEN
            v_shipment_id := v_shipment.id;
            v_tracking := v_shipment.tracking_number;
            v_status := v_shipment.status;
            v_eta := CASE
                WHEN v_shipment.promised_delivery_date IS NOT NULL
                    THEN to_char(v_shipment.promised_delivery_date, 'YYYY-MM-DD')
                ELSE 'N/A'
            END;
        END IF;
    END IF;

    -- Choose templates (policy-provided overrides, else defaults).
    v_template := COALESCE(
        v_intents->v_intent->>'template',
        CASE
            WHEN v_intent = 'status' THEN 'Shipment {tracking_number}: status {status}. ETA {eta}.'
            WHEN v_intent = 'eta' THEN 'ETA for {tracking_number}: {eta}.'
            ELSE 'Thanks for your message. We will get back to you shortly.'
        END
    );
    v_not_found_template := COALESCE(
        v_intents->v_intent->>'not_found_template',
        'Sorry, no shipment found for {recipient}.'
    );

    IF v_intent IN ('status', 'eta') AND v_shipment_id IS NULL THEN
        v_message := v_not_found_template;
    ELSE
        v_message := v_template;
    END IF;

    -- Token replacement (basic).
    v_message := replace(v_message, '{tracking_number}', COALESCE(v_tracking, 'N/A'));
    v_message := replace(v_message, '{status}', COALESCE(v_status, 'unknown'));
    v_message := replace(v_message, '{eta}', COALESCE(v_eta, 'N/A'));
    v_message := replace(v_message, '{recipient}', COALESCE(v_recipient, ''));

    BEGIN
        v_corr := (p_comm->>'correlation_id')::UUID;
    EXCEPTION
        WHEN others THEN
            v_corr := NULL;
    END;

    IF NOT v_dry_run THEN
        IF v_recipient IS NULL THEN
            v_error := 'recipient_missing';
        ELSIF v_auth_config_id IS NULL THEN
            v_error := 'auth_config_missing';
        ELSE
            SELECT credentials->>'api_key' INTO v_api_key
              FROM provider_auth_configs
             WHERE id = v_auth_config_id;

            IF v_api_key IS NULL THEN
                v_error := 'api_key_missing';
            ELSE
                v_headers := jsonb_build_object(
                    'Authorization', format('Bearer %s', v_api_key),
                    'Content-Type', 'application/json'
                );
                v_body := jsonb_build_object(
                    'to', v_recipient,
                    'recipient_type', 'individual',
                    'type', 'text',
                    'text', jsonb_build_object('body', v_message)
                );

                v_resp := call_api(
                    'https://waba.360dialog.io/v1/messages',
                    'POST',
                    v_headers,
                    v_body,
                    30
                );
                v_sent := COALESCE((v_resp->>'status')::INT, 0) BETWEEN 200 AND 299;
                IF NOT v_sent THEN
                    v_error := format('send_failed_status_%s', v_resp->>'status');
                END IF;
            END IF;
        END IF;
    END IF;

    v_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'intent', v_intent,
        'message', v_message,
        'recipient', v_recipient,
        'message_id', v_message_id,
        'shipment_id', v_shipment_id,
        'sent', v_sent,
        'dry_run', v_dry_run,
        'api_status', v_resp->>'status',
        'error', v_error
    ));

    PERFORM log_decision(
        p_organization_id := p_organization_id,
        p_decision_category := 'communication_reply',
        p_resource_type := 'webhook_inbox',
        p_resource_id := p_webhook_id,
        p_decision_point := 'auto_reply',
        p_decision_outcome := CASE
            WHEN v_error IS NOT NULL THEN 'reply_skipped'
            WHEN v_sent THEN 'reply_sent'
            ELSE 'reply_pending'
        END,
        p_performed_by_system := 'dialog360_reply_autohandler',
        p_correlation_id := v_corr,
        p_decision_inputs := v_decision_inputs,
        p_decision_reason := v_error
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'intent', v_intent,
        'message', v_message,
        'sent', v_sent,
        'error', v_error,
        'shipment_id', v_shipment_id,
        'api_status', v_resp->>'status'
    ));
END;
$$;

COMMIT;
