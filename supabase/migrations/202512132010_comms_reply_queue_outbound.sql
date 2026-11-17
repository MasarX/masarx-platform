-- Migration: Queue comms auto-replies via outbound_calls (no in-trigger network)
-- Purpose:
--   - Remove hardcoded provider selection (derive from auth_config_id).
--   - Remove hardcoded token fallbacks (render missing tokens as empty via render_template).
--   - Enqueue WhatsApp sends to outbound_calls for worker-driven delivery.
-- Date: 2025-12-13

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
    v_requires_shipment BOOLEAN := FALSE;
    v_message TEXT;
    v_eta TEXT;
    v_tracking TEXT;
    v_status TEXT;
    v_shipment RECORD;
    v_shipment_id UUID := NULL;
    v_auth_config_id UUID;
    v_dry_run BOOLEAN := FALSE;
    v_outbound_call_id UUID := NULL;
    v_queued BOOLEAN := FALSE;
    v_error TEXT := NULL;
    v_decision_inputs JSONB;
    v_corr UUID := NULL;
    v_render_context JSONB;
BEGIN
    -- Resolve policy via ladder: resource -> tenant -> global.
    v_policy := resolve_settings('comms_reply_policy', 'resource', p_webhook_source_id);
    IF v_policy IS NOT NULL THEN
        v_policy_scope := 'resource';
    ELSIF p_organization_id IS NOT NULL THEN
        v_policy := resolve_settings('comms_reply_policy', 'tenant', p_organization_id);
        IF v_policy IS NOT NULL THEN
            v_policy_scope := 'tenant';
        END IF;
    END IF;
    IF v_policy IS NULL THEN
        v_policy := resolve_settings('comms_reply_policy', 'global', NULL);
        IF v_policy IS NOT NULL THEN
            v_policy_scope := 'global';
        END IF;
    END IF;

    IF v_policy IS NULL THEN
        RETURN jsonb_build_object('status', 'skipped', 'reason', 'policy_missing');
    END IF;

    v_auth_config_id := NULLIF(v_policy->>'auth_config_id', '')::UUID;
    v_intents := COALESCE(v_policy->'intents', '{}'::jsonb);
    v_dry_run := COALESCE((v_policy->>'dry_run')::BOOLEAN, FALSE);

    -- Determine intent via keyword match (policy-driven).
    FOR v_intent IN
        SELECT key
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

    -- Extract templates; no hardcoded defaults.
    v_template := NULLIF(v_intents->v_intent->>'template', '');
    v_not_found_template := NULLIF(v_intents->v_intent->>'not_found_template', '');

    IF v_template IS NULL THEN
        RETURN jsonb_strip_nulls(jsonb_build_object(
            'status', 'skipped',
            'reason', 'template_missing',
            'intent', v_intent,
            'policy_scope', v_policy_scope
        ));
    END IF;

    -- If the intent declares a not_found_template, treat it as a shipment lookup intent by default.
    v_requires_shipment := COALESCE((v_intents->v_intent->>'requires_shipment')::BOOLEAN, (v_intents->v_intent ? 'not_found_template'));

    -- Load shipment context when required (organization-scoped).
    IF v_requires_shipment THEN
        IF p_organization_id IS NULL THEN
            v_error := 'organization_missing_for_lookup';
        ELSIF v_recipient IS NOT NULL THEN
            SELECT s.id,
                   s.tracking_number,
                   s.status,
                   s.promised_delivery_date
              INTO v_shipment
              FROM shipments s
              JOIN recipients r ON r.id = s.recipient_id
             WHERE s.organization_id = p_organization_id
               AND r.organization_id = p_organization_id
               AND r.phone_number = v_recipient
             ORDER BY s.created_at DESC
             LIMIT 1;

            IF FOUND THEN
                v_shipment_id := v_shipment.id;
                v_tracking := v_shipment.tracking_number;
                v_status := v_shipment.status;
                v_eta := CASE
                    WHEN v_shipment.promised_delivery_date IS NOT NULL
                        THEN to_char(v_shipment.promised_delivery_date, 'YYYY-MM-DD')
                    ELSE NULL
                END;
            END IF;
        END IF;
    END IF;

    IF v_requires_shipment AND v_shipment_id IS NULL THEN
        IF v_not_found_template IS NULL THEN
            v_error := COALESCE(v_error, 'not_found_template_missing');
        ELSE
            v_message := v_not_found_template;
        END IF;
    ELSE
        v_message := v_template;
    END IF;

    -- Token rendering: support legacy {token} placeholders by converting to {{token}} and using render_template().
    v_render_context := jsonb_strip_nulls(jsonb_build_object(
        'tracking_number', v_tracking,
        'status', v_status,
        'eta', v_eta,
        'recipient', v_recipient,
        'message_id', v_message_id
    ));
    IF v_message IS NOT NULL THEN
        v_message := regexp_replace(v_message, '\{([A-Za-z0-9_]+)\}', '{{\1}}', 'g');
        v_message := trim(both '"' FROM public.render_template(to_jsonb(v_message), v_render_context)::TEXT);
    END IF;

    BEGIN
        v_corr := (p_comm->>'correlation_id')::UUID;
    EXCEPTION
        WHEN others THEN
            v_corr := NULL;
    END;

    IF NOT v_dry_run AND v_error IS NULL THEN
        IF v_recipient IS NULL THEN
            v_error := 'recipient_missing';
        ELSIF v_auth_config_id IS NULL THEN
            v_error := 'auth_config_missing';
        ELSIF v_message IS NULL OR btrim(v_message) = '' THEN
            v_error := 'message_empty';
        ELSE
            BEGIN
                v_outbound_call_id := public.enqueue_comms_whatsapp(
                    v_auth_config_id,
                    v_recipient,
                    v_message,
                    v_corr,
                    v_shipment_id,
                    jsonb_strip_nulls(jsonb_build_object(
                        'source', 'send_comms_reply',
                        'webhook_id', p_webhook_id,
                        'webhook_source_id', p_webhook_source_id,
                        'intent', v_intent,
                        'policy_scope', v_policy_scope,
                        'message_id', v_message_id
                    ))
                );
                v_queued := v_outbound_call_id IS NOT NULL;
            EXCEPTION
                WHEN others THEN
                    v_error := SQLERRM;
                    v_queued := FALSE;
            END;
        END IF;
    END IF;

    v_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'intent', v_intent,
        'message', v_message,
        'recipient', v_recipient,
        'message_id', v_message_id,
        'shipment_id', v_shipment_id,
        'dry_run', v_dry_run,
        'queued', v_queued,
        'outbound_call_id', v_outbound_call_id,
        'requires_shipment', v_requires_shipment,
        'error', v_error,
        'policy_scope', v_policy_scope
    ));

    PERFORM log_decision(
        p_organization_id := p_organization_id,
        p_decision_category := 'communication_reply',
        p_resource_type := 'webhook_inbox',
        p_resource_id := p_webhook_id,
        p_decision_point := 'auto_reply',
        p_decision_outcome := CASE
            WHEN v_error IS NOT NULL THEN 'reply_skipped'
            WHEN v_dry_run THEN 'reply_dry_run'
            WHEN v_queued THEN 'reply_queued'
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
        'queued', v_queued,
        'outbound_call_id', v_outbound_call_id,
        'error', v_error,
        'shipment_id', v_shipment_id,
        'policy_scope', v_policy_scope
    ));
END;
$$;

COMMIT;

