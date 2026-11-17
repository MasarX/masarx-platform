BEGIN;

DROP FUNCTION IF EXISTS get_recent_outbound_calls(INTEGER);

CREATE FUNCTION get_recent_outbound_calls(p_limit INTEGER DEFAULT 10)
RETURNS TABLE (
    id UUID,
    call_type TEXT,
    target_type TEXT,
    target_id UUID,
    status TEXT,
    method TEXT,
    url TEXT,
    created_at TIMESTAMPTZ,
    response_status_code INT,
    error_message TEXT,
    context JSONB
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT
        oc.id,
        oc.call_type,
        oc.target_type,
        oc.target_id,
        oc.status,
        oc.method,
        oc.url,
        oc.created_at,
        oc.response_status_code,
        oc.error_message,
        oc.context
    FROM outbound_calls oc
    ORDER BY oc.created_at DESC
    LIMIT GREATEST(p_limit, 1)
$$;

COMMENT ON FUNCTION get_recent_outbound_calls(INTEGER)
    IS 'Admin helper: view recent outbound_calls entries for debugging.';

COMMIT;
