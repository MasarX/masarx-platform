-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Fix API gateway postprocess ON CONFLICT inference for tracking_upper
-- Purpose:
--   - Postgres requires matching index predicate when inferring partial unique indexes.
--   - Our uniqueness for tracking_upper is enforced by a partial unique index:
--       uniq_shipments_client_tracking_upper ON shipments(client_id, tracking_upper)
--       WHERE tracking_number IS NOT NULL
--   - Ensure workflow_handlers.process_api_gateway_outbound_response_v1 uses the
--     same predicate for ON CONFLICT inference (idempotent repair).
-- Date: 2025-12-30

BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_outbound_response_v1(public.outbound_calls, jsonb)'::regprocedure
  ) INTO v_def;

  IF v_def IS NULL OR v_def = '' THEN
    RAISE EXCEPTION 'process_api_gateway_outbound_response_v1 function definition not found';
  END IF;

  IF v_def ~ 'ON CONFLICT\s*\(\s*client_id\s*,\s*tracking_upper\s*\)\s+WHERE\s+tracking_number\s+IS\s+NOT\s+NULL\s+DO' THEN
    -- already fixed
  ELSE
    v_def := regexp_replace(
      v_def,
      'ON CONFLICT\s*\(\s*client_id\s*,\s*tracking_upper\s*\)\s*DO',
      'ON CONFLICT (client_id, tracking_upper) WHERE tracking_number IS NOT NULL DO',
      'g'
    );

    IF v_def !~ 'ON CONFLICT\s*\(\s*client_id\s*,\s*tracking_upper\s*\)\s+WHERE\s+tracking_number\s+IS\s+NOT\s+NULL\s+DO' THEN
      RAISE EXCEPTION 'Failed to patch process_api_gateway_outbound_response_v1 ON CONFLICT predicate';
    END IF;
  END IF;

  EXECUTE v_def;
END;
$$;

COMMIT;
