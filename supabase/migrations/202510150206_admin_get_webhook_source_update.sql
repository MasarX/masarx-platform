-- Update admin helper to support listing webhook sources when token is null.

BEGIN;

DROP FUNCTION IF EXISTS get_webhook_source_by_token(TEXT);

CREATE FUNCTION get_webhook_source_by_token(p_token TEXT)
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
    WHERE p_token IS NULL OR ws.auth_token = p_token
    ORDER BY ws.created_at DESC
    LIMIT CASE WHEN p_token IS NULL THEN 10 ELSE 1 END
$$;

COMMENT ON FUNCTION get_webhook_source_by_token(TEXT)
    IS 'Admin helper: resolve webhook source metadata (including client) by bearer token for debugging.';

COMMIT;
