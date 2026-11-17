-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S05
-- Migration: claim_pending_jobs edge fallback
-- Purpose:
--   - Allow DB outbound_worker to lease pending_edge jobs only when the edge api-caller pipeline
--     is not configured in this environment.
--   - Prevent pending_edge starvation in cloud projects that don't have run_api_caller_batch +
--     required settings yet.
-- Date: 2026-01-09

BEGIN;

SET search_path TO public, extensions, pg_temp;

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
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_edge_ready BOOLEAN := FALSE;
    v_edge_settings JSONB;
    v_supabase_public JSONB;
    v_endpoint_url TEXT;
    v_anon_key TEXT;
BEGIN
    -- Edge readiness is treated as: api-caller function exists + required global settings are present.
    -- If not ready, pending_edge is treated as DB-executable to avoid starvation.
    v_edge_ready := to_regprocedure('public.run_api_caller_batch(int)') IS NOT NULL;

    SELECT s.cached_value
      INTO v_edge_settings
      FROM public.settings s
     WHERE s.category = 'edge_dispatch_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     ORDER BY s.last_updated DESC
     LIMIT 1;

    v_endpoint_url := NULLIF(COALESCE(v_edge_settings->>'endpoint_url', ''), '');

    SELECT s.cached_value
      INTO v_supabase_public
      FROM public.settings s
     WHERE s.category = 'supabase_public'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     ORDER BY s.last_updated DESC
     LIMIT 1;

    v_anon_key := NULLIF(COALESCE(v_supabase_public->>'anon_key', ''), '');

    v_edge_ready := v_edge_ready AND v_endpoint_url IS NOT NULL AND v_anon_key IS NOT NULL;

    RETURN QUERY
    UPDATE public.outbound_calls AS oc
       SET lease_expires_at = now() + interval '30 seconds'
     WHERE oc.id IN (
        SELECT oc2.id
          FROM public.outbound_calls oc2
         WHERE (
               oc2.status = 'pending'
               OR (NOT v_edge_ready AND oc2.status = 'pending_edge')
         )
           AND oc2.scheduled_at <= now()
           AND (oc2.lease_expires_at IS NULL OR oc2.lease_expires_at < now())
         ORDER BY oc2.priority DESC, oc2.scheduled_at
         LIMIT GREATEST(COALESCE(p_batch_size, 10), 1)
         FOR UPDATE SKIP LOCKED
     )
     RETURNING oc.id, oc.call_type, oc.target_type, oc.target_id, oc.method, oc.url, oc.headers, oc.body,
               oc.priority, oc.retry_count, oc.max_retries, oc.correlation_id, oc.shipment_id, oc.context;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_jobs(INT)
  IS 'Claim due outbound_calls for DB execution (status=pending). If edge api-caller is not configured, also claim pending_edge to avoid starvation.';

COMMIT;
