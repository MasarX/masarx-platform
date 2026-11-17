-- Migration: send_comms_reply session tracking + richer context for downstream policy enforcement
-- Purpose:
--   - Record inbound WhatsApp session windows (recipient_channel_sessions) on every reply.
--   - Ensure outbound_calls context includes organization/client/sender/recipient ids for compliance + auditing.
-- Date: 2025-12-14

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
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_policy_row RECORD;
    v_policy JSONB := '{}'::jsonb;
    v_intents JSONB := '{}'::jsonb;
    v_match_text TEXT;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_settings_version_id UUID;
    v_policy_version INT;
    v_scope_path JSONB := '[]'::jsonb;
    v_settings_resolution_id UUID;

    v_reply_text TEXT := lower(COALESCE(p_comm->>'reply_text', ''));
    v_reply_payload TEXT := lower(COALESCE(p_comm->>'reply_payload', ''));
    v_recipient_raw TEXT := NULLIF(p_comm->>'recipient', '');
    v_recipient TEXT := public.normalize_phone_number(v_recipient_raw);
    v_message_id TEXT := NULLIF(p_comm->>'message_id', '');

    v_intent TEXT := 'fallback';
    v_intent_cfg JSONB := '{}'::jsonb;
    v_template TEXT;
    v_not_found_template TEXT;
    v_requires_shipment BOOLEAN := FALSE;
    v_stop_workflow BOOLEAN := FALSE;
    v_opt_out BOOLEAN := FALSE;
    v_allow_opted_out_send BOOLEAN := FALSE;

    v_message TEXT;
    v_eta TEXT;
    v_tracking TEXT;
    v_status TEXT;
    v_shipment RECORD;
    v_shipment_id UUID := NULL;
    v_lookup_reason TEXT := NULL;

    v_sender_id UUID := NULL;
    v_client_id UUID := NULL;
    v_auth_config_id UUID := NULL;

    v_recipient_id UUID := NULL;
    v_is_opted_out BOOLEAN := FALSE;
    v_inbound_at TIMESTAMPTZ := NULL;

    v_dry_run BOOLEAN := FALSE;
    v_outbound_call_id UUID := NULL;
    v_queued BOOLEAN := FALSE;
    v_error TEXT := NULL;
    v_decision_inputs JSONB;
    v_corr UUID := NULL;
    v_render_context JSONB;
BEGIN
    -- Resolve sender/client context from webhook source (prevents cross-client leakage within org).
    SELECT ws.sender_id, s.client_id
      INTO v_sender_id, v_client_id
      FROM public.webhook_sources ws
      LEFT JOIN public.senders s ON s.id = ws.sender_id
     WHERE ws.id = p_webhook_source_id;

    -- Resolve comms_reply_policy via full ladder starting at source scope.
    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row('comms_reply_policy', 'source', p_webhook_source_id)
      LIMIT 1;

    IF NOT FOUND OR v_policy_row.value IS NULL THEN
        RETURN jsonb_build_object('status', 'skipped', 'reason', 'policy_missing');
    END IF;

    v_policy := v_policy_row.value;
    v_policy_scope_type := v_policy_row.scope_type;
    v_policy_scope_id := v_policy_row.scope_id;
    v_policy_settings_id := v_policy_row.settings_id;
    v_policy_settings_version_id := v_policy_row.settings_version_id;
    v_policy_version := v_policy_row.version;
    v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

    v_auth_config_id := NULLIF(v_policy->>'auth_config_id', '')::UUID;
    v_intents := COALESCE(v_policy->'intents', '{}'::jsonb);
    v_dry_run := COALESCE((v_policy->>'dry_run')::BOOLEAN, FALSE);

    v_settings_resolution_id := public.log_settings_resolution(
        p_organization_id := p_organization_id,
        p_category := 'comms_reply_policy',
        p_winning_scope_type := v_policy_scope_type,
        p_winning_scope_id := v_policy_scope_id,
        p_winning_settings_id := v_policy_settings_id,
        p_winning_settings_version_id := v_policy_settings_version_id,
        p_winning_version := v_policy_version,
        p_scope_path := v_scope_path,
        p_inputs := jsonb_strip_nulls(jsonb_build_object(
            'webhook_id', p_webhook_id,
            'webhook_source_id', p_webhook_source_id,
            'sender_id', v_sender_id,
            'client_id', v_client_id,
            'recipient', v_recipient,
            'message_id', v_message_id
        )),
        p_merge_notes := NULL
    );

    -- Determine intent via keyword match (policy-driven), checking both text and payload.
    v_match_text := trim(both ' ' FROM (v_reply_text || ' ' || v_reply_payload));
    FOR v_intent IN
        SELECT key
        FROM jsonb_object_keys(v_intents) AS key
        WHERE key <> 'fallback'
    LOOP
        IF EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(v_intents->v_intent->'keywords', '[]'::jsonb)) AS kw
            WHERE v_match_text LIKE '%' || lower(kw) || '%'
        ) THEN
            EXIT;
        END IF;
        v_intent := 'fallback';
    END LOOP;

    v_intent_cfg := COALESCE(v_intents->v_intent, '{}'::jsonb);
    v_template := NULLIF(v_intent_cfg->>'template', '');
    v_not_found_template := NULLIF(v_intent_cfg->>'not_found_template', '');
    v_requires_shipment := COALESCE(
        NULLIF(v_intent_cfg->>'requires_shipment', '')::BOOLEAN,
        (v_intent_cfg ? 'not_found_template')
    );
    v_stop_workflow := COALESCE(NULLIF(v_intent_cfg->>'stop_workflow', '')::BOOLEAN, FALSE);
    v_opt_out := COALESCE(NULLIF(v_intent_cfg->>'opt_out', '')::BOOLEAN, FALSE);
    v_allow_opted_out_send := COALESCE(NULLIF(v_intent_cfg->>'allow_opted_out_send', '')::BOOLEAN, v_opt_out);

    IF v_template IS NULL THEN
        RETURN jsonb_strip_nulls(jsonb_build_object(
            'status', 'skipped',
            'reason', 'template_missing',
            'intent', v_intent,
            'policy_scope', v_policy_scope_type
        ));
    END IF;

    -- Parse inbound timestamp (epoch seconds) when provided.
    BEGIN
      IF NULLIF(p_comm->>'timestamp', '') IS NOT NULL THEN
        v_inbound_at := to_timestamp((p_comm->>'timestamp')::DOUBLE PRECISION);
      END IF;
    EXCEPTION
      WHEN others THEN
        v_inbound_at := NULL;
    END;

    -- Resolve recipient_id for consent enforcement (client-scoped).
    IF v_client_id IS NOT NULL AND v_recipient IS NOT NULL THEN
        SELECT id
          INTO v_recipient_id
          FROM public.recipients
         WHERE client_id = v_client_id
           AND phone_number_normalized = v_recipient
         ORDER BY created_at DESC
         LIMIT 1;
    END IF;

    -- Record WhatsApp session start/refresh for compliance (inbound message opens a 24h window).
    IF v_recipient_id IS NOT NULL THEN
      PERFORM public.touch_recipient_channel_session(v_recipient_id, 'whatsapp', v_inbound_at);
    END IF;

    IF v_recipient_id IS NOT NULL THEN
        SELECT opted_out
          INTO v_is_opted_out
          FROM public.recipient_preferences
         WHERE recipient_id = v_recipient_id
           AND channel = 'whatsapp'
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1;
        v_is_opted_out := COALESCE(v_is_opted_out, FALSE);
    END IF;

    -- Apply opt-out action if policy intent requires it.
    IF v_opt_out AND v_recipient_id IS NOT NULL THEN
        PERFORM public.set_recipient_opt_out(v_recipient_id, 'whatsapp', TRUE);
        v_is_opted_out := TRUE;
    END IF;

    -- Enforce opt-out (unless this intent explicitly allows sending while opted out).
    IF v_is_opted_out AND NOT v_allow_opted_out_send THEN
        v_error := 'recipient_opted_out';
    END IF;

    -- Shipment lookup when required (org + client + normalized phone scoped).
    IF v_requires_shipment THEN
        IF p_organization_id IS NULL THEN
            v_lookup_reason := 'organization_missing_for_lookup';
        ELSIF v_client_id IS NULL THEN
            v_lookup_reason := 'client_missing_for_lookup';
        ELSIF v_recipient IS NOT NULL THEN
            SELECT s.id,
                   s.tracking_number,
                   s.status,
                   s.promised_delivery_date
              INTO v_shipment
              FROM public.shipments s
              JOIN public.recipients r ON r.id = s.recipient_id
             WHERE s.organization_id = p_organization_id
               AND s.client_id = v_client_id
               AND r.client_id = v_client_id
               AND r.organization_id = p_organization_id
               AND r.phone_number_normalized = v_recipient
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
            v_error := 'not_found_template_missing';
        ELSE
            v_message := v_not_found_template;
        END IF;
    ELSE
        v_message := v_template;
    END IF;

    -- Token rendering: support legacy {token} placeholders via {{token}} + render_template().
    v_render_context := jsonb_strip_nulls(jsonb_build_object(
        'tracking_number', v_tracking,
        'status', v_status,
        'eta', v_eta,
        'recipient', v_recipient,
        'message_id', v_message_id,
        'lookup_reason', v_lookup_reason
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
                        'organization_id', p_organization_id,
                        'sender_id', v_sender_id,
                        'client_id', v_client_id,
                        'recipient_id', v_recipient_id,
                        'intent', v_intent,
                        'opt_out', v_opt_out,
                        'allow_opted_out_send', v_allow_opted_out_send,
                        'policy_scope', v_policy_scope_type,
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
        'recipient_id', v_recipient_id,
        'message_id', v_message_id,
        'shipment_id', v_shipment_id,
        'dry_run', v_dry_run,
        'queued', v_queued,
        'outbound_call_id', v_outbound_call_id,
        'requires_shipment', v_requires_shipment,
        'lookup_reason', v_lookup_reason,
        'stop_workflow', v_stop_workflow,
        'opt_out', v_opt_out,
        'error', v_error,
        'policy_scope', v_policy_scope_type
    ));

    PERFORM public.log_decision(
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
        p_performed_by_system := 'comms_reply_workflow',
        p_correlation_id := v_corr,
        p_decision_inputs := v_decision_inputs,
        p_decision_reason := v_error,
        p_settings_resolution_id := v_settings_resolution_id
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'intent', v_intent,
        'message', v_message,
        'queued', v_queued,
        'outbound_call_id', v_outbound_call_id,
        'error', v_error,
        'shipment_id', v_shipment_id,
        'policy_scope', v_policy_scope_type,
        'settings_resolution_id', v_settings_resolution_id,
        'stop_workflow', v_stop_workflow,
        'opt_out', v_opt_out
    ));
END;
$$;

COMMIT;
