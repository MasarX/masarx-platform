-- Migration: Enqueue WhatsApp sends via outbound_calls (provider-auth driven)
-- Purpose: Centralize WhatsApp send spec building (no hardcoding) and enqueue to outbound_calls for worker-driven delivery.
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
    v_messaging_product TEXT;
    v_headers JSONB;
    v_body JSONB;
    v_url TEXT;
    v_outbound_call_id UUID;
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

    SELECT COALESCE(cached_value->>'messaging_product', cached_value->>'messagingProduct')
      INTO v_messaging_product
      FROM settings
     WHERE category = 'provider_defaults'
       AND scope_type = 'resource'
       AND scope_id = v_provider_id
     ORDER BY last_updated DESC NULLS LAST
     LIMIT 1;

    IF v_messaging_product IS NULL THEN
        RAISE EXCEPTION 'messaging_product_missing';
    END IF;

    v_url := format('%s/v1/messages', trim(trailing '/' from v_base_url));
    v_headers := jsonb_build_object(
        'D360-API-KEY', v_api_key,
        'Content-Type', 'application/json'
    );
    v_body := jsonb_build_object(
        'to', p_recipient,
        'recipient_type', 'individual',
        'type', 'text',
        'messaging_product', v_messaging_product,
        'text', jsonb_build_object('body', p_message_text)
    );

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
    IS 'Build WhatsApp send spec from provider_auth_configs + provider_defaults and enqueue into outbound_calls (worker-driven delivery).';

COMMIT;

