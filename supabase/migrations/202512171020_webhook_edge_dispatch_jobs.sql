-- Plan: PLAN-202512-comms-reply-edge-dispatch-v1 / Step: S04
-- Migration: Webhook edge dispatch helper (job lookup)
-- Purpose:
--   - Let webhook-receiver trigger low-latency edge dispatch after intake completes,
--     without hardcoding provider-specific behavior in the edge function.
-- Date: 2025-12-17

BEGIN;

CREATE OR REPLACE FUNCTION public.get_webhook_edge_dispatch_jobs(p_webhook_id UUID)
RETURNS TABLE (
  job_id UUID,
  timeout_seconds INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  IF p_webhook_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    oc.id AS job_id,
    CASE
      WHEN NULLIF((oc.context->'edge_dispatch'->>'timeout_seconds')::TEXT, '') ~ '^[0-9]+$'
        THEN NULLIF((oc.context->'edge_dispatch'->>'timeout_seconds')::TEXT, '')::INT
      ELSE NULL
    END AS timeout_seconds
  FROM public.outbound_calls oc
  WHERE oc.status = 'pending_edge'
    AND oc.scheduled_at <= now()
    AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
    AND oc.context->>'webhook_id' = p_webhook_id::TEXT
    AND COALESCE(NULLIF((oc.context->'edge_dispatch'->>'immediate')::TEXT, '')::BOOLEAN, FALSE) = TRUE
  ORDER BY oc.created_at DESC
  LIMIT 10;
END;
$$;

COMMENT ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID)
  IS 'Return pending_edge outbound_calls flagged for immediate edge dispatch for a given webhook_inbox id.';

REVOKE EXECUTE ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION public.get_webhook_edge_dispatch_jobs(UUID) TO service_role;

COMMIT;

