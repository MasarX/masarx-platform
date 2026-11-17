BEGIN;

CREATE OR REPLACE FUNCTION insert_webhook_inbox_record(
    p_id UUID,
    p_webhook_source_id UUID,
    p_provider_type TEXT,
    p_raw_payload JSONB,
    p_headers JSONB,
    p_processing_status TEXT,
    p_correlation_id UUID,
    p_idempotency_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id UUID := COALESCE(p_id, gen_random_uuid());
BEGIN
    INSERT INTO webhook_inbox (
        id,
        webhook_source_id,
        provider_type,
        raw_payload,
        headers,
        processing_status,
        correlation_id,
        idempotency_key
    )
    VALUES (
        v_id,
        p_webhook_source_id,
        p_provider_type,
        COALESCE(p_raw_payload, '{}'::jsonb),
        COALESCE(p_headers, '{}'::jsonb),
        COALESCE(p_processing_status, 'pending'),
        p_correlation_id,
        p_idempotency_key
    );

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION insert_webhook_inbox_record(UUID, UUID, TEXT, JSONB, JSONB, TEXT, UUID, TEXT)
    IS 'Security definer helper to insert webhook inbox records bypassing RLS.';

COMMIT;
