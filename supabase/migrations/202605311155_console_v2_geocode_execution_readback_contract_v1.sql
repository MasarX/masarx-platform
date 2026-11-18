-- Migration: Console V2 geocode execution readback contract
-- Date: 2026-05-31
-- Purpose:
--   Enrich the shipment geocode execution RPC with durable geocoding ledger,
--   geocode cache, and manual-review task IDs so Console can prove the same
--   backend state it shows after an operator action.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605311155_console_v2_geocode_execution_readback_contract_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  IF to_regprocedure('public.ui_execute_shipment_update_geocode_v1_execution_base(text,text,text[],text,integer,jsonb)') IS NULL THEN
    ALTER FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
      RENAME TO ui_execute_shipment_update_geocode_v1_execution_base;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ui_execute_shipment_update_geocode_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT 0,
  p_params JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_result JSONB := '{}'::jsonb;
  v_first_item JSONB := '{}'::jsonb;
  v_workflow_run_id UUID := NULL;
  v_workflow_created_at TIMESTAMPTZ := NULL;
  v_address_id UUID := NULL;
  v_geocode_workflow_run_id UUID := NULL;
  v_geocode_workflow_status TEXT := NULL;
  v_geocoding_attempt_id UUID := NULL;
  v_geocoding_attempt_status TEXT := NULL;
  v_geocode_id UUID := NULL;
  v_manual_review_task_id UUID := NULL;
  v_failure_reason TEXT := NULL;
  v_enrichment JSONB := '{}'::jsonb;
  v_item_enrichment JSONB := '{}'::jsonb;
  v_prev_claims TEXT := NULL;
  v_prev_claim_role TEXT := NULL;
BEGIN
  v_prev_claims := current_setting('request.jwt.claims', TRUE);
  v_prev_claim_role := current_setting('request.jwt.claim.role', TRUE);

  v_result := public.ui_execute_shipment_update_geocode_v1_execution_base(
    p_action_key,
    p_resource_key,
    p_selection_ids,
    p_selection_id,
    p_selection_count,
    COALESCE(p_params, '{}'::jsonb)
  );

  IF v_result IS NULL OR jsonb_typeof(v_result) <> 'object' THEN
    PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), TRUE);
    PERFORM set_config('request.jwt.claim.role', COALESCE(v_prev_claim_role, ''), TRUE);
    RETURN v_result;
  END IF;

  IF jsonb_typeof(v_result->'items') = 'array' AND jsonb_array_length(v_result->'items') > 0 THEN
    v_first_item := COALESCE(v_result->'items'->0, '{}'::jsonb);
  END IF;

  BEGIN
    v_workflow_run_id := COALESCE(
      NULLIF(v_result->>'workflow_run_id', '')::UUID,
      NULLIF(v_first_item->>'workflow_run_id', '')::UUID
    );
  EXCEPTION WHEN others THEN
    v_workflow_run_id := NULL;
  END;

  BEGIN
    v_address_id := COALESCE(
      NULLIF(v_result->>'address_id', '')::UUID,
      NULLIF(v_first_item->>'address_id', '')::UUID,
      NULLIF(v_first_item->>'destination_address_id', '')::UUID
    );
  EXCEPTION WHEN others THEN
    v_address_id := NULL;
  END;

  BEGIN
    v_geocode_workflow_run_id := COALESCE(
      NULLIF(v_result->>'geocode_workflow_run_id', '')::UUID,
      NULLIF(v_first_item->>'geocode_workflow_run_id', '')::UUID
    );
  EXCEPTION WHEN others THEN
    v_geocode_workflow_run_id := NULL;
  END;

  v_geocode_workflow_status := COALESCE(
    NULLIF(v_result->>'geocode_workflow_status', ''),
    NULLIF(v_first_item->>'geocode_workflow_status', '')
  );

  IF v_workflow_run_id IS NOT NULL THEN
    SELECT wr.created_at
      INTO v_workflow_created_at
      FROM public.workflow_runs wr
     WHERE wr.id = v_workflow_run_id;
  END IF;

  IF v_geocode_workflow_run_id IS NULL AND v_workflow_run_id IS NOT NULL THEN
    SELECT NULLIF(wrs.operation_result->>'geocode_workflow_run_id', '')::UUID,
           NULLIF(wrs.operation_result->>'geocode_workflow_status', '')
      INTO v_geocode_workflow_run_id,
           v_geocode_workflow_status
      FROM public.workflow_run_steps wrs
     WHERE wrs.workflow_run_id = v_workflow_run_id
       AND wrs.operation_result ? 'geocode_workflow_run_id'
     ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
     LIMIT 1;
  END IF;

  SELECT ga.id,
         ga.status,
         COALESCE(
           NULLIF(ga.metadata->>'failure_reason', ''),
           NULLIF(ga.metadata->>'error', ''),
           NULLIF(ga.metadata->>'reason', '')
         )
    INTO v_geocoding_attempt_id,
         v_geocoding_attempt_status,
         v_failure_reason
    FROM public.geocoding_attempts ga
    JOIN public.workflow_run_steps wrs
      ON wrs.id = ga.workflow_run_step_id
   WHERE (v_address_id IS NULL OR ga.address_id = v_address_id)
     AND (
       (v_geocode_workflow_run_id IS NOT NULL AND wrs.workflow_run_id = v_geocode_workflow_run_id)
       OR (v_workflow_run_id IS NOT NULL AND wrs.workflow_run_id = v_workflow_run_id)
     )
   ORDER BY ga.updated_at DESC, ga.created_at DESC
   LIMIT 1;

  IF v_geocode_id IS NULL AND v_address_id IS NOT NULL THEN
    SELECT g.id
      INTO v_geocode_id
      FROM public.geocodes g
     WHERE g.address_id = v_address_id
       AND g.is_primary IS TRUE
     ORDER BY g.geocoded_at DESC
     LIMIT 1;
  END IF;

  IF v_geocode_id IS NULL AND v_address_id IS NOT NULL THEN
    SELECT g.id
      INTO v_geocode_id
      FROM public.geocodes g
     WHERE g.address_id = v_address_id
     ORDER BY g.geocoded_at DESC
     LIMIT 1;
  END IF;

  SELECT mrt.id
    INTO v_manual_review_task_id
    FROM public.manual_review_tasks mrt
   WHERE (
       v_geocode_workflow_run_id IS NOT NULL
       AND mrt.metadata->>'workflow_run_id' = v_geocode_workflow_run_id::TEXT
     )
      OR (
       v_address_id IS NOT NULL
       AND mrt.address_id = v_address_id
       AND (v_workflow_created_at IS NULL OR mrt.created_at >= v_workflow_created_at)
     )
   ORDER BY mrt.created_at DESC
   LIMIT 1;

  IF v_failure_reason IS NULL AND v_geocode_workflow_run_id IS NOT NULL THEN
    SELECT COALESCE(
        NULLIF(wr.last_error->>'error', ''),
        NULLIF(wr.last_error->>'message', ''),
        NULLIF(wr.last_error::TEXT, 'null'),
        NULLIF(wrs.last_error, '')
      )
      INTO v_failure_reason
      FROM public.workflow_runs wr
      LEFT JOIN public.workflow_run_steps wrs
        ON wrs.workflow_run_id = wr.id
       AND wrs.last_error IS NOT NULL
     WHERE wr.id = v_geocode_workflow_run_id
     ORDER BY wrs.sequence_order DESC NULLS LAST
     LIMIT 1;
  END IF;

  v_enrichment := jsonb_strip_nulls(jsonb_build_object(
    'geocode_workflow_run_id', v_geocode_workflow_run_id,
    'geocode_workflow_status', v_geocode_workflow_status,
    'geocoding_attempt_id', v_geocoding_attempt_id,
    'geocoding_attempt_status', v_geocoding_attempt_status,
    'geocode_id', v_geocode_id,
    'manual_review_task_id', v_manual_review_task_id,
    'geocode_failure_reason', v_failure_reason
  ));

  v_item_enrichment := jsonb_strip_nulls(jsonb_build_object(
    'geocode_workflow_run_id', v_geocode_workflow_run_id,
    'geocode_workflow_status', v_geocode_workflow_status,
    'geocoding_attempt_id', v_geocoding_attempt_id,
    'geocoding_attempt_status', v_geocoding_attempt_status,
    'geocode_id', v_geocode_id,
    'manual_review_task_id', v_manual_review_task_id,
    'geocode_failure_reason', v_failure_reason
  ));

  v_result := v_result || v_enrichment;

  IF jsonb_typeof(v_result->'items') = 'array' AND jsonb_array_length(v_result->'items') > 0 THEN
    v_result := jsonb_set(v_result, '{items,0}', v_first_item || v_item_enrichment, FALSE);
  END IF;

  PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), TRUE);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_prev_claim_role, ''), TRUE);

  RETURN v_result;
EXCEPTION WHEN others THEN
  PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), TRUE);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_prev_claim_role, ''), TRUE);
  RAISE;
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) IS
  'Console V2 geocode execution entrypoint with backend readback IDs for workflow, geocoding_attempts, geocodes, and manual_review_tasks.';

REVOKE ALL ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_shipment_update_geocode_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605311155_console_v2_geocode_execution_readback_contract_v1'));
COMMIT;
