-- Plan: PLAN-202512-shipment-references-ssot / Step: S95
-- Migration: Normalize shipment_create idempotency operation_result
-- Purpose:
--   - Keep workflow handler response contracts stable for idempotent shipment_create.
--   - Prior behavior expected `operation_result.operation = 'reused'` when the create
--     step reuses a shipment via tracking uniqueness.
--   - A previous refactor introduced `reused_tracking`, which breaks integration
--     expectations without adding actionable value (cause is already derivable via
--     decision_log + context).
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

  IF v_def ~ $op$v_operation\s*:=\s*'reused_tracking'$op$ THEN
    v_def := regexp_replace(
      v_def,
      $op$v_operation\s*:=\s*'reused_tracking'$op$,
      $op$v_operation := 'reused'$op$,
      'g'
    );
  END IF;

  IF v_def ~ $op$v_operation\s*:=\s*'reused_tracking'$op$ THEN
    RAISE EXCEPTION 'Failed to normalize execute_shipment_create_v1 operation value';
  END IF;

  EXECUTE v_def;
END;
$$;

COMMIT;
