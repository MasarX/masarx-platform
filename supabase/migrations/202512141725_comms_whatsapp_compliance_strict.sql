-- Migration: WhatsApp enqueue compliance strictness + provenance
-- Purpose:
--   - Remove hardcoded defaults from enqueue_comms_whatsapp compliance enforcement (all behavior is settings-driven).
--   - Log compliance settings provenance when a send is blocked for compliance reasons.
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION public.enqueue_comms_whatsapp(
    p_auth_config_id UUID,
    p_recipient TEXT,
    p_message_text TEXT,
    p_correlation_id UUID DEFAULT NULL,
    p_shipment_id UUID DEFAULT NULL,
    p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_provider_id UUID;
    v_api_key TEXT;
    v_base_url TEXT;
    v_defaults JSONB;
    v_messaging_product TEXT;
    v_whatsapp JSONB;
    v_messages_path TEXT;
    v_api_key_header TEXT;
    v_headers_template JSONB;
    v_body_template JSONB;
    v_headers JSONB;
    v_body JSONB;
    v_url TEXT;
    v_outbound_call_id UUID;
    v_render_context JSONB;

    -- Derived context (best-effort)
    v_recipient_norm TEXT := public.normalize_phone_number(p_recipient);
    v_client_id UUID := NULL;
    v_recipient_id UUID := NULL;
    v_org_id UUID := NULL;

    -- Compliance policy resolution + (failure) provenance
    v_policy_ctx JSONB := '{}'::jsonb;
    v_compliance_row RECORD;
    v_compliance JSONB := '{}'::jsonb;
    v_enforce_text_session BOOLEAN;
    v_session_window_seconds INT;
    v_allow_webhook_session_evidence BOOLEAN;
    v_allowed_sources JSONB;
    v_source TEXT;
    v_allow_outside_session BOOLEAN := FALSE;
    v_webhook_id UUID := NULL;
    v_webhook_created_at TIMESTAMPTZ := NULL;
    v_last_inbound TIMESTAMPTZ := NULL;
    v_settings_resolution_id UUID := NULL;

    v_auth JSONB := '{}'::jsonb;
    v_operation_template_id UUID := NULL;
BEGIN
    IF p_auth_config_id IS NULL THEN
        RAISE EXCEPTION 'auth_config_missing';
    END IF;
    IF p_recipient IS NULL OR btrim(p_recipient) = '' THEN
        RAISE EXCEPTION 'recipient_missing';
    END IF;
    IF p_message_text IS NULL THEN
        RAISE EXCEPTION 'message_missing';
    END IF;

    -- Enrich context with shipment-derived client/recipient + org when available.
    IF p_shipment_id IS NOT NULL THEN
      SELECT s.client_id, s.recipient_id
        INTO v_client_id, v_recipient_id
        FROM public.shipments s
       WHERE s.id = p_shipment_id;
    END IF;

    BEGIN
      v_client_id := COALESCE(v_client_id, NULLIF(p_context->>'client_id', '')::UUID);
    EXCEPTION
      WHEN others THEN
        v_client_id := v_client_id;
    END;

    BEGIN
      v_recipient_id := COALESCE(v_recipient_id, NULLIF(p_context->>'recipient_id', '')::UUID);
    EXCEPTION
      WHEN others THEN
        v_recipient_id := v_recipient_id;
    END;

    BEGIN
      v_org_id := NULLIF(p_context->>'organization_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_org_id := NULL;
    END;
    IF v_org_id IS NULL AND v_client_id IS NOT NULL THEN
      SELECT organization_id
        INTO v_org_id
        FROM public.clients
       WHERE id = v_client_id;
    END IF;

    v_policy_ctx := jsonb_strip_nulls(
      COALESCE(p_context, '{}'::jsonb)
      || jsonb_build_object(
        'client_id', v_client_id,
        'recipient_id', v_recipient_id,
        'organization_id', v_org_id
      )
    );

    SELECT *
      INTO v_compliance_row
      FROM public.resolve_settings_row_from_context('whatsapp_compliance_policy', v_policy_ctx)
      LIMIT 1;

    IF NOT FOUND OR v_compliance_row.value IS NULL THEN
      RAISE EXCEPTION 'whatsapp_compliance_policy_missing';
    END IF;

    v_compliance := v_compliance_row.value;

    -- Strict parsing (no hardcoded defaults).
    v_enforce_text_session := NULLIF(v_compliance->>'enforce_text_session', '')::BOOLEAN;
    IF v_enforce_text_session IS NULL THEN
      RAISE EXCEPTION 'whatsapp_compliance_policy_missing_enforce_text_session';
    END IF;

    v_session_window_seconds := NULLIF(v_compliance->>'session_window_seconds', '')::INT;
    IF v_session_window_seconds IS NULL OR v_session_window_seconds <= 0 THEN
      RAISE EXCEPTION 'whatsapp_compliance_policy_invalid_session_window';
    END IF;

    v_allow_webhook_session_evidence := NULLIF(v_compliance->>'allow_webhook_session_evidence', '')::BOOLEAN;
    IF v_allow_webhook_session_evidence IS NULL THEN
      RAISE EXCEPTION 'whatsapp_compliance_policy_missing_allow_webhook_session_evidence';
    END IF;

    v_allowed_sources := v_compliance->'allow_freeform_outside_session_sources';
    IF v_allowed_sources IS NULL OR jsonb_typeof(v_allowed_sources) <> 'array' THEN
      RAISE EXCEPTION 'whatsapp_compliance_policy_invalid_allow_freeform_outside_session_sources';
    END IF;

    v_source := NULLIF(p_context->>'source', '');
    IF v_source IS NOT NULL THEN
      v_allow_outside_session := EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(v_allowed_sources) AS s(val)
        WHERE lower(s.val) = lower(v_source)
      );
    END IF;

    -- Enforce session window for freeform-text sends unless explicitly allowed by policy.
    BEGIN
      IF v_enforce_text_session AND NOT v_allow_outside_session THEN
        BEGIN
          v_webhook_id := NULLIF(p_context->>'webhook_id', '')::UUID;
        EXCEPTION
          WHEN others THEN
            v_webhook_id := NULL;
        END;

        IF v_recipient_id IS NULL AND v_client_id IS NULL THEN
          BEGIN
            v_client_id := NULLIF(p_context->>'client_id', '')::UUID;
          EXCEPTION
            WHEN others THEN
              v_client_id := NULL;
          END;
        END IF;

        IF v_recipient_id IS NULL AND v_client_id IS NOT NULL AND v_recipient_norm IS NOT NULL THEN
          SELECT id
            INTO v_recipient_id
            FROM public.recipients
           WHERE client_id = v_client_id
             AND phone_number_normalized = v_recipient_norm
           ORDER BY created_at DESC
           LIMIT 1;
        END IF;

        IF v_recipient_id IS NULL THEN
          IF v_allow_webhook_session_evidence AND v_webhook_id IS NOT NULL THEN
            SELECT created_at
              INTO v_webhook_created_at
              FROM public.webhook_inbox
             WHERE id = v_webhook_id;

            IF v_webhook_created_at IS NULL THEN
              RAISE EXCEPTION 'whatsapp_session_missing';
            END IF;

            IF v_webhook_created_at < (now() - make_interval(secs => v_session_window_seconds)) THEN
              RAISE EXCEPTION 'whatsapp_session_expired_template_required';
            END IF;
          ELSE
            RAISE EXCEPTION 'whatsapp_compliance_recipient_unresolved';
          END IF;
        END IF;

        IF v_recipient_id IS NOT NULL THEN
          SELECT last_inbound_at
            INTO v_last_inbound
            FROM public.recipient_channel_sessions
           WHERE recipient_id = v_recipient_id
             AND channel = 'whatsapp'
           LIMIT 1;

          IF v_last_inbound IS NULL THEN
            RAISE EXCEPTION 'whatsapp_session_missing';
          END IF;

          IF v_last_inbound < (now() - make_interval(secs => v_session_window_seconds)) THEN
            RAISE EXCEPTION 'whatsapp_session_expired_template_required';
          END IF;
        END IF;
      END IF;
    EXCEPTION
      WHEN others THEN
        -- Only log when we can attach to an org; avoid raising secondary errors.
        IF v_org_id IS NOT NULL THEN
          v_settings_resolution_id := public.log_settings_resolution(
            p_organization_id := v_org_id,
            p_category := 'whatsapp_compliance_policy',
            p_winning_scope_type := v_compliance_row.scope_type,
            p_winning_scope_id := v_compliance_row.scope_id,
            p_winning_settings_id := v_compliance_row.settings_id,
            p_winning_settings_version_id := v_compliance_row.settings_version_id,
            p_winning_version := v_compliance_row.version,
            p_scope_path := v_compliance_row.scope_path,
            p_inputs := jsonb_strip_nulls(jsonb_build_object(
              'shipment_id', p_shipment_id,
              'webhook_id', v_webhook_id,
              'source', v_source,
              'recipient', v_recipient_norm,
              'client_id', v_client_id,
              'recipient_id', v_recipient_id
            )),
            p_merge_notes := NULL
          );

          PERFORM public.log_decision(
            p_organization_id := v_org_id,
            p_decision_category := 'comms_whatsapp',
            p_resource_type := 'correlation',
            p_resource_id := COALESCE(p_correlation_id, gen_random_uuid()),
            p_decision_point := 'whatsapp_compliance',
            p_decision_outcome := 'blocked',
            p_performed_by_system := 'enqueue_comms_whatsapp',
            p_correlation_id := p_correlation_id,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
              'shipment_id', p_shipment_id,
              'webhook_id', v_webhook_id,
              'source', v_source,
              'recipient', v_recipient_norm,
              'client_id', v_client_id,
              'recipient_id', v_recipient_id
            )),
            p_decision_reason := SQLERRM,
            p_settings_resolution_id := v_settings_resolution_id
          );
        END IF;

        RAISE;
    END;

    -- Resolve provider + validate api_key presence (do not persist it in outbound_calls).
    SELECT pac.provider_id, NULLIF(pac.credentials->>'api_key', '')
      INTO v_provider_id, v_api_key
      FROM public.provider_auth_configs pac
     WHERE pac.id = p_auth_config_id;

    IF v_provider_id IS NULL THEN
        RAISE EXCEPTION 'provider_missing_for_auth_config';
    END IF;
    IF v_api_key IS NULL THEN
        RAISE EXCEPTION 'api_key_missing';
    END IF;

    -- Attach an operation_template_id to the job context when possible so that outbound
    -- response processing can reuse the canonical response mapping (no hardcoded parsing).
    BEGIN
      v_operation_template_id := NULLIF(p_context->>'operation_template_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_operation_template_id := NULL;
    END;

    IF v_operation_template_id IS NULL THEN
      SELECT ot.id
        INTO v_operation_template_id
        FROM public.operation_templates ot
       WHERE ot.provider_id = v_provider_id
         AND ot.call_type = 'comms_whatsapp'
       ORDER BY ot.updated_at DESC
       LIMIT 1;
    END IF;

    SELECT COALESCE(metadata->>'base_url', metadata->>'baseUrl')
      INTO v_base_url
      FROM public.providers
     WHERE id = v_provider_id;

    IF v_base_url IS NULL THEN
        RAISE EXCEPTION 'base_url_missing';
    END IF;

    SELECT cached_value
      INTO v_defaults
      FROM public.settings
     WHERE category = 'provider_defaults'
       AND scope_type = 'resource'
       AND scope_id = v_provider_id
     ORDER BY last_updated DESC NULLS LAST
     LIMIT 1;

    v_defaults := COALESCE(v_defaults, '{}'::jsonb);
    v_messaging_product := NULLIF(COALESCE(v_defaults->>'messaging_product', v_defaults->>'messagingProduct'), '');
    IF v_messaging_product IS NULL THEN
        RAISE EXCEPTION 'messaging_product_missing';
    END IF;

    v_whatsapp := COALESCE(v_defaults->'whatsapp', '{}'::jsonb);
    v_messages_path := NULLIF(COALESCE(v_whatsapp->>'messages_path', v_whatsapp->>'messagesPath'), '');
    v_api_key_header := NULLIF(COALESCE(v_whatsapp->>'api_key_header', v_whatsapp->>'apiKeyHeader'), '');
    v_headers_template := COALESCE(v_whatsapp->'headers_template', v_whatsapp->'headersTemplate');
    v_body_template := COALESCE(v_whatsapp->'text_body_template', v_whatsapp->'textBodyTemplate');

    IF v_messages_path IS NULL THEN
        RAISE EXCEPTION 'whatsapp_messages_path_missing';
    END IF;
    IF v_api_key_header IS NULL THEN
        RAISE EXCEPTION 'whatsapp_api_key_header_missing';
    END IF;
    IF v_headers_template IS NULL OR jsonb_typeof(v_headers_template) <> 'object' THEN
        RAISE EXCEPTION 'whatsapp_headers_template_missing';
    END IF;
    IF v_body_template IS NULL OR jsonb_typeof(v_body_template) <> 'object' THEN
        RAISE EXCEPTION 'whatsapp_text_body_template_missing';
    END IF;

    v_url := regexp_replace(v_base_url, '/+$', '') || '/' || regexp_replace(v_messages_path, '^/+', '');

    v_render_context := jsonb_strip_nulls(jsonb_build_object(
        'recipient', v_recipient_norm,
        'message_text', p_message_text,
        'messaging_product', v_messaging_product
    ));

    v_headers := public.render_template(v_headers_template, v_render_context);
    v_body := public.render_template(v_body_template, v_render_context);

    -- Dispatch-time auth injection (no secrets stored in outbound_calls).
    v_auth := jsonb_build_object(
      'mode', 'api_key_header',
      'auth_type', 'api_key',
      'auth_config_id', p_auth_config_id,
      'header', v_api_key_header,
      'credential_key', 'api_key'
    );

    INSERT INTO public.outbound_calls (
        call_type,
        target_type,
        target_id,
        method,
        url,
        headers,
        body,
        priority,
        max_retries,
        shipment_id,
        correlation_id,
        context
    )
    VALUES (
        'comms_whatsapp',
        'provider',
        v_provider_id,
        'POST',
        v_url,
        COALESCE(v_headers, '{}'::jsonb),
        COALESCE(v_body, '{}'::jsonb),
        100,
        2,
        p_shipment_id,
        p_correlation_id,
        jsonb_strip_nulls(
          COALESCE(p_context, '{}'::jsonb)
          || jsonb_build_object(
            'organization_id', v_org_id,
            'client_id', v_client_id,
            'recipient_id', v_recipient_id,
            'auth', v_auth,
            'operation_template_id', v_operation_template_id
          )
        )
    )
    RETURNING id INTO v_outbound_call_id;

    RETURN v_outbound_call_id;
END;
$$;

COMMENT ON FUNCTION public.enqueue_comms_whatsapp(UUID, TEXT, TEXT, UUID, UUID, JSONB)
    IS 'Enqueue WhatsApp freeform text send into outbound_calls with strict, policy-driven compliance enforcement; secrets injected at dispatch-time only.';

COMMIT;

