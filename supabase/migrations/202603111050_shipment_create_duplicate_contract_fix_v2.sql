-- Plan: PLAN-202603-webhook-shipment-ingestion-contract-hardening / Step: S04
-- Migration: Shipment create duplicate contract fixup v2
-- Purpose:
--   - Preserve the inserted operation when duplicate preflight returns no row.
--   - Preserve policy-derived service_type defaults in API shipment-create helper.
-- Date: 2026-03-11

BEGIN;

DO $$
DECLARE
  v_def TEXT;
  v_old TEXT := $old$
      ) AS resolved
     LIMIT 1;

    IF v_row_id IS NULL THEN
$old$;
  v_new TEXT := $new$
      ) AS resolved
     LIMIT 1;

    IF v_operation IS NULL THEN
      v_operation := 'inserted';
    END IF;

    IF v_row_id IS NULL THEN
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
  ) INTO v_def;

  IF v_def IS NULL OR v_def = '' THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 function definition not found';
  END IF;

  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END;
$$;

DO $$
DECLARE
  v_def TEXT;
  v_old_operation TEXT := $old$
    ) AS resolved
   LIMIT 1;

  IF v_shipment_id IS NULL THEN
$old$;
  v_new_operation TEXT := $new$
    ) AS resolved
   LIMIT 1;

  IF v_operation IS NULL THEN
    v_operation := 'inserted';
  END IF;

  IF v_shipment_id IS NULL THEN
$new$;
  v_old_service_type TEXT := $old$
  END IF;

  v_special_instructions := NULLIF(workflow_handlers.resolve_path_text(v_request_body, v_extract->>'special_instructions_path'), '');
$old$;
  v_new_service_type TEXT := $new$
  END IF;

  IF v_service_type IS NULL THEN
    v_service_type := COALESCE(NULLIF(v_post->>'service_type', ''), 'delivery');
  END IF;

  v_special_instructions := NULLIF(workflow_handlers.resolve_path_text(v_request_body, v_extract->>'special_instructions_path'), '');
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_shipment_create_v1(public.outbound_calls,jsonb,public.api_gateway_requests,public.api_routes)'::regprocedure
  ) INTO v_def;

  IF v_def IS NULL OR v_def = '' THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 function definition not found';
  END IF;

  v_def := replace(v_def, v_old_operation, v_new_operation);
  v_def := replace(v_def, v_old_service_type, v_new_service_type);

  EXECUTE v_def;
END;
$$;

COMMIT;
