-- Plan: PLAN-202601-logestechs-outbound-http2-fix / Step: S04
-- Migration: Restore api-caller batch runner (edge) + fix claim_pending_jobs edge readiness
-- Purpose:
--   - Re-enable autonomous edge execution for outbound_calls in status='pending_edge' via pg_cron.
--   - Fix edge readiness detection so DB does NOT execute provider HTTP (pg_net) when edge pipeline is configured.
-- Date: 2026-01-09

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Ensure pg_cron exists (required for autonomous tick).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Settings schema: edge_dispatch_policy
-- (Used by resolve_settings + scripts/utils/settings-upsert.js; seeded via ops scripts, not hardcoded here.)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'edge_dispatch_policy',
  1,
  jsonb_build_object(
    '$schema', 'https://json-schema.org/draft/2020-12/schema',
    'type', 'object',
    'additionalProperties', FALSE,
    'properties', jsonb_build_object(
      'endpoint_url', jsonb_build_object('type', 'string', 'minLength', 1, 'format', 'uri'),
      'enabled', jsonb_build_object('type', 'boolean'),
      'batch_size', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 1000),
      'timeout_seconds', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 60)
    ),
    'required', jsonb_build_array('endpoint_url')
  ),
  'Edge dispatch settings for api-caller (endpoint_url + optional tuning).',
  jsonb_build_array(
    jsonb_build_object('endpoint_url', 'https://<edge-host>/functions/v1/api-caller', 'enabled', TRUE, 'batch_size', 25, 'timeout_seconds', 15)
  ),
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM public.schema_registry
   WHERE category = 'edge_dispatch_policy'
     AND version = 1
);

-- Resolve endpoint URL from settings (SSOT).
CREATE OR REPLACE FUNCTION public.resolve_api_caller_endpoint_v1()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_settings JSONB;
  v_url TEXT;
BEGIN
  v_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);
  v_url := NULLIF(COALESCE(v_settings->>'endpoint_url', ''), '');
  IF v_url IS NULL THEN
    RAISE EXCEPTION 'resolve_api_caller_endpoint_v1: endpoint_url not configured (settings: edge_dispatch_policy)';
  END IF;
  RETURN v_url;
END;
$$;

-- Helper: resolve whether edge dispatch is enabled (settings-driven).
CREATE OR REPLACE FUNCTION public.resolve_edge_dispatch_enabled_v1()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_settings JSONB;
  v_enabled BOOLEAN;
BEGIN
  v_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);
  BEGIN
    v_enabled := COALESCE(NULLIF(v_settings->>'enabled', '')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_enabled := TRUE;
  END;
  RETURN v_enabled;
END;
$$;

-- Resolve a Supabase JWT to call the Edge Function (stored in provider_auth_configs for provider.name='edge_api_caller').
CREATE OR REPLACE FUNCTION public.resolve_edge_api_caller_jwt_v1()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT (pac.credentials->>'shared_secret')::TEXT
    INTO v_token
    FROM public.providers p
    JOIN public.provider_auth_configs pac ON pac.provider_id = p.id
   WHERE p.name = 'edge_api_caller'
   ORDER BY pac.created_at DESC
   LIMIT 1;

  IF v_token IS NULL OR btrim(v_token) = '' THEN
    RAISE EXCEPTION 'resolve_edge_api_caller_jwt_v1: shared_secret missing for provider edge_api_caller';
  END IF;

  -- Basic shape check (JWT has 3 dot-separated segments).
  IF v_token !~ '^[^.]+\\.[^.]+\\.[^.]+$' THEN
    RAISE EXCEPTION 'resolve_edge_api_caller_jwt_v1: token is not a JWT (expected 3 segments)';
  END IF;

  RETURN v_token;
END;
$$;

-- Batch runner: POST to api-caller with Authorization: Bearer <service_role|edge_api_caller_role JWT>
CREATE OR REPLACE FUNCTION public.run_api_caller_batch(p_batch INT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_url TEXT := public.resolve_api_caller_endpoint_v1();
  v_jwt TEXT := public.resolve_edge_api_caller_jwt_v1();
  v_settings JSONB := resolve_settings('edge_dispatch_policy', 'global', NULL);
  v_timeout INT := NULL;
  v_batch INT;
  v_headers JSONB := jsonb_build_object(
    'content-type', 'application/json',
    'authorization', concat('Bearer ', v_jwt)
  );
  v_body JSONB := jsonb_build_object('batch', v_batch);
  v_result JSONB;
BEGIN
  IF public.resolve_edge_dispatch_enabled_v1() IS FALSE THEN
    RETURN jsonb_build_object('status', 'disabled');
  END IF;

  BEGIN
    v_batch := COALESCE(NULLIF(p_batch, 0), NULLIF(v_settings->>'batch_size', '')::INT, 25);
  EXCEPTION
    WHEN others THEN
      v_batch := 25;
  END;
  v_batch := LEAST(GREATEST(v_batch, 1), 1000);

  IF v_settings ? 'timeout_seconds' THEN
    v_timeout := (v_settings->>'timeout_seconds')::INT;
  END IF;

  v_body := jsonb_build_object('batch', v_batch);

  v_result := public.call_api(v_url, 'POST', v_headers, v_body, COALESCE(v_timeout, 15));
  RETURN v_result;
END;
$$;

-- Worker tick: row-driven via cron_config (check_throttle) + edge_dispatch_policy.
CREATE OR REPLACE FUNCTION public.run_edge_api_caller_worker()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_processed INT := 0;
  v_error BOOLEAN := FALSE;
  v_settings JSONB;
  v_batch INT;
  v_result JSONB;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('edge_api_caller_worker');
  IF NOT v_throttle.should_run THEN
    RETURN jsonb_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  IF public.resolve_edge_dispatch_enabled_v1() IS FALSE THEN
    PERFORM public.update_cron_config('edge_api_caller_worker');
    RETURN jsonb_build_object('status', 'disabled');
  END IF;

  v_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);
  BEGIN
    v_batch := COALESCE(NULLIF(v_settings->>'batch_size', '')::INT, NULLIF(v_throttle.batch_size, 0), 25);
  EXCEPTION
    WHEN others THEN
      v_batch := COALESCE(NULLIF(v_throttle.batch_size, 0), 25);
  END;
  v_batch := LEAST(GREATEST(v_batch, 1), 1000);

  v_context := public.create_request_context('edge_api_caller_worker');
  BEGIN
    v_result := public.run_api_caller_batch(v_batch);
    v_processed := 1;
  EXCEPTION
    WHEN others THEN
      v_error := TRUE;
  END;

  PERFORM public.complete_request_context(v_context, v_error, v_processed);
  PERFORM public.update_cron_config('edge_api_caller_worker');

  RETURN jsonb_build_object(
    'status', 'completed',
    'items_processed', v_processed,
    'error_occurred', v_error,
    'batch', v_batch,
    'result', v_result
  );
END;
$$;

COMMENT ON FUNCTION public.run_edge_api_caller_worker()
  IS 'Autonomous tick to invoke edge api-caller batch execution (row-driven via cron_config + edge_dispatch_policy).';

INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'edge_api_caller_worker',
  'outbound',
  'Invokes Edge api-caller to execute outbound_calls intended for edge (pending_edge).',
  '*/1 * * * *',
  '{"batch_size": 25}'::jsonb,
  true
)
ON CONFLICT (worker_name) DO UPDATE
SET
  worker_type = EXCLUDED.worker_type,
  description = EXCLUDED.description,
  schedule = EXCLUDED.schedule,
  config = EXCLUDED.config,
  is_active = EXCLUDED.is_active,
  updated_at = now();

INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
  'edge_api_caller_worker',
  60,
  25,
  true,
  'Throttle config for edge api-caller autonomous tick.'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

-- Schedule worker tick via pg_cron (idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'api_caller_batch_tick') THEN
    PERFORM cron.unschedule((SELECT jobid FROM cron.job WHERE jobname = 'api_caller_batch_tick'));
  END IF;
  PERFORM cron.schedule('api_caller_batch_tick', '*/1 * * * *', 'SELECT public.run_edge_api_caller_worker();');
END $$;

-- Fix edge readiness detection for claim_pending_jobs:
-- Ready iff: run_api_caller_batch exists + endpoint_url set + edge_api_caller JWT present.
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
    v_endpoint_url TEXT;
    v_edge_jwt_present BOOLEAN := FALSE;
    v_edge_enabled BOOLEAN := TRUE;
BEGIN
    v_edge_ready := to_regprocedure('public.run_api_caller_batch(int)') IS NOT NULL;

    v_edge_settings := resolve_settings('edge_dispatch_policy', 'global', NULL);
    v_endpoint_url := NULLIF(COALESCE(v_edge_settings->>'endpoint_url', ''), '');
    BEGIN
      v_edge_enabled := COALESCE(NULLIF(v_edge_settings->>'enabled', '')::BOOLEAN, TRUE);
    EXCEPTION
      WHEN others THEN
        v_edge_enabled := TRUE;
    END;

    SELECT EXISTS (
      SELECT 1
        FROM public.providers p
        JOIN public.provider_auth_configs pac ON pac.provider_id = p.id
       WHERE p.name = 'edge_api_caller'
         AND NULLIF(COALESCE(pac.credentials->>'shared_secret', ''), '') IS NOT NULL
    ) INTO v_edge_jwt_present;

    v_edge_ready := v_edge_ready AND v_edge_enabled AND v_endpoint_url IS NOT NULL AND v_edge_jwt_present;

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
  IS 'Claim due outbound_calls for DB execution (status=pending). If edge api-caller is NOT configured, also claim pending_edge to avoid starvation.';

COMMIT;
