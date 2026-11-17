-- Migration: claim_pending_jobs qualification fix

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_pending_jobs(
    p_batch_size INT
)
RETURNS TABLE (
    job_id UUID,
    call_type TEXT,
    target_type TEXT,
    target_id UUID,
    method TEXT,
    url TEXT,
    headers JSONB,
    body JSONB,
    priority INT,
    retry_count INT,
    max_retries INT,
    correlation_id UUID,
    shipment_id UUID,
    context JSONB
)
LANGUAGE plpgsql
SET search_path TO 'public, pg_temp'
AS $$
BEGIN
    RETURN QUERY
    UPDATE public.outbound_calls AS oc
    SET lease_expires_at = now() + interval '30 seconds'
    WHERE oc.id IN (
        SELECT oc2.id
        FROM public.outbound_calls oc2
        WHERE oc2.status = 'pending'
          AND (oc2.lease_expires_at IS NULL OR oc2.lease_expires_at < now())
        ORDER BY oc2.priority DESC, oc2.scheduled_at
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    )
    RETURNING oc.id, oc.call_type, oc.target_type, oc.target_id, oc.method, oc.url, oc.headers, oc.body,
              oc.priority, oc.retry_count, oc.max_retries, oc.correlation_id, oc.shipment_id, oc.context;
END;
$$;

COMMIT;

