-- Migration: Qualify pgcrypto usage in webhook token hashing functions

BEGIN;

CREATE OR REPLACE FUNCTION public.webhook_sources_hash_token()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.auth_token IS NOT NULL THEN
        NEW.auth_token_hash := extensions.crypt(NEW.auth_token, extensions.gen_salt('bf'));
        NEW.auth_token := NULL;
    ELSIF NEW.auth_token_hash IS NULL AND TG_OP = 'UPDATE' THEN
        NEW.auth_token_hash := OLD.auth_token_hash;
    END IF;

    IF NEW.auth_token_hash IS NULL THEN
        RAISE EXCEPTION 'auth_token_hash must be set (use crypt())';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_webhook_source_by_token(p_token TEXT)
RETURNS TABLE (
    id UUID,
    source_identifier TEXT,
    provider_type TEXT,
    organization_id UUID,
    sender_id UUID,
    client_id UUID,
    enabled BOOLEAN,
    mapping_config_id UUID
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT
        ws.id,
        ws.source_identifier,
        ws.provider_type,
        ws.organization_id,
        ws.sender_id,
        s.client_id,
        ws.enabled,
        ws.mapping_config_id
    FROM public.webhook_sources ws
    LEFT JOIN public.senders s ON s.id = ws.sender_id
    WHERE p_token IS NULL
       OR (ws.auth_token_hash IS NOT NULL AND extensions.crypt(p_token, ws.auth_token_hash) = ws.auth_token_hash)
    ORDER BY ws.created_at DESC
    LIMIT CASE WHEN p_token IS NULL THEN 10 ELSE 1 END
$$;

COMMIT;
