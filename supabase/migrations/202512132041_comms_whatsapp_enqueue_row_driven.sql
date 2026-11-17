-- Migration: Row-driven WhatsApp enqueue (provider_defaults.whatsapp)
-- Purpose: Remove any provider-specific HTTP constants from enqueue_comms_whatsapp; derive URL/headers/body from provider_defaults.
-- Date: 2025-12-13

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

    SELECT pac.provider_id, NULLIF(pac.credentials->>'api_key', '')
      INTO v_provider_id, v_api_key
      FROM provider_auth_configs pac
     WHERE pac.id = p_auth_config_id;

    IF v_provider_id IS NULL THEN
        RAISE EXCEPTION 'provider_missing_for_auth_config';
    END IF;
    IF v_api_key IS NULL THEN
        RAISE EXCEPTION 'api_key_missing';
    END IF;

    SELECT COALESCE(metadata->>'base_url', metadata->>'baseUrl')
      INTO v_base_url
      FROM providers
     WHERE id = v_provider_id;

    IF v_base_url IS NULL THEN
        RAISE EXCEPTION 'base_url_missing';
    END IF;

    SELECT cached_value
      INTO v_defaults
      FROM settings
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
    IF left(v_messages_path, 1) <> '/' THEN
        RAISE EXCEPTION 'whatsapp_messages_path_invalid';
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

    v_url := trim(trailing '/' from v_base_url) || v_messages_path;

    v_headers := v_headers_template;
    v_headers := jsonb_set(v_headers, ARRAY[v_api_key_header], to_jsonb(v_api_key), TRUE);

    v_render_context := jsonb_strip_nulls(jsonb_build_object(
        'recipient', p_recipient,
        'message_text', p_message_text,
        'messaging_product', v_messaging_product
    ));
    v_body := jsonb_strip_nulls(public.render_template(v_body_template, v_render_context));

    INSERT INTO outbound_calls (
        call_type,
        target_type,
        target_id,
        method,
        url,
        headers,
        body,
        correlation_id,
        shipment_id,
        context
    )
    VALUES (
        'comms_whatsapp',
        'provider',
        v_provider_id,
        'POST',
        v_url,
        v_headers,
        v_body,
        p_correlation_id,
        p_shipment_id,
        COALESCE(p_context, '{}'::jsonb)
    )
    RETURNING id INTO v_outbound_call_id;

    RETURN v_outbound_call_id;
END;
$$;

COMMENT ON FUNCTION public.enqueue_comms_whatsapp(UUID, TEXT, TEXT, UUID, UUID, JSONB)
    IS 'Build WhatsApp send spec from provider_auth_configs + provider_defaults.whatsapp and enqueue into outbound_calls (worker-driven delivery).';

COMMIT;

