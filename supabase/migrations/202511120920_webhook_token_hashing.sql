-- Migration: Webhook token hashing
-- Purpose: Store webhook source tokens as salted hashes and enforce crypt-based comparisons.
-- Date: 2025-11-12

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE webhook_sources
    ADD COLUMN IF NOT EXISTS auth_token_hash TEXT;

UPDATE webhook_sources
SET auth_token_hash = crypt(auth_token, gen_salt('bf'))
WHERE auth_token IS NOT NULL;

ALTER TABLE webhook_sources
    ALTER COLUMN auth_token DROP NOT NULL;

ALTER TABLE webhook_sources
    DROP CONSTRAINT IF EXISTS webhook_sources_auth_token_key;

ALTER TABLE webhook_sources
    ALTER COLUMN auth_token_hash SET NOT NULL;

ALTER TABLE webhook_sources
    ADD CONSTRAINT webhook_sources_auth_token_hash_key UNIQUE (auth_token_hash);

UPDATE webhook_sources
SET auth_token = NULL;

COMMENT ON COLUMN webhook_sources.auth_token
    IS 'Deprecated: raw tokens are redacted. Use auth_token_hash for comparisons.';
COMMENT ON COLUMN webhook_sources.auth_token_hash
    IS 'BCrypt hash of webhook bearer token; compare via crypt().';

CREATE OR REPLACE FUNCTION webhook_sources_hash_token()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.auth_token IS NOT NULL THEN
        NEW.auth_token_hash := crypt(NEW.auth_token, gen_salt('bf'));
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

DROP TRIGGER IF EXISTS trg_webhook_sources_hash_token ON webhook_sources;

CREATE TRIGGER trg_webhook_sources_hash_token
BEFORE INSERT OR UPDATE ON webhook_sources
FOR EACH ROW
EXECUTE FUNCTION webhook_sources_hash_token();

CREATE OR REPLACE FUNCTION get_webhook_source_by_token(p_token TEXT)
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
    FROM webhook_sources ws
    LEFT JOIN senders s ON s.id = ws.sender_id
    WHERE p_token IS NULL
       OR (ws.auth_token_hash IS NOT NULL AND crypt(p_token, ws.auth_token_hash) = ws.auth_token_hash)
    ORDER BY ws.created_at DESC
    LIMIT CASE WHEN p_token IS NULL THEN 10 ELSE 1 END
$$;

COMMENT ON FUNCTION get_webhook_source_by_token(TEXT)
    IS 'Admin helper: resolve webhook source metadata (including client) by bearer token for debugging.';

COMMIT;
