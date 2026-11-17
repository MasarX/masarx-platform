-- Plan: PLAN-202512-shipment-references-ssot / Step: S95
-- Migration: Fix ON CONFLICT inference for tracking_upper
-- Purpose:
--   - Postgres requires matching index predicate when inferring partial unique indexes.
--   - Our uniqueness for tracking_upper is enforced by a partial unique index:
--       uniq_shipments_client_tracking_upper ON shipments(client_id, tracking_upper)
--       WHERE tracking_number IS NOT NULL
--   - Runtime handlers using `ON CONFLICT (client_id, tracking_upper)` must include the
--     same predicate, otherwise execution fails with:
--       "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- Date: 2025-12-29

BEGIN;

DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure
  ) INTO v_def;

  IF v_def IS NULL OR v_def = '' THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 function definition not found';
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
      RAISE EXCEPTION 'Failed to patch execute_shipment_create_v1 ON CONFLICT predicate';
    END IF;
  END IF;

  EXECUTE v_def;
END;
$$;

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
