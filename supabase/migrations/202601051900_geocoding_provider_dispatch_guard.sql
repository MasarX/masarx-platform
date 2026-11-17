-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S04
-- Migration: Geocoding provider dispatch guard (sequence bounds + manual review fallback)
-- Purpose:
--   - Avoid hard failures when provider_sequence_index exceeds provider_priority length.
--   - Return a workflow-safe manual review outcome instead of raising exceptions.
-- Alignment: SIMPLE, SCALABLE, DYNAMIC, workflow-driven (row-based policy).
-- Date: 2026-01-05

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $$
BEGIN
  IF to_regprocedure('workflow_handlers.execute_provider_dispatch_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL
     AND to_regprocedure('workflow_handlers.execute_provider_dispatch_v1(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION workflow_handlers.execute_provider_dispatch_v1(public.workflow_run_steps, public.workflow_runs, jsonb) RENAME TO execute_provider_dispatch_v1_base';
  END IF;

  IF to_regprocedure('workflow_handlers.execute_provider_dispatch_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'execute_provider_dispatch_v1_base missing; cannot apply provider dispatch guard';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
  v_provider_candidates TEXT[];
  v_sequence_index INT;
  v_response public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);

  v_provider_candidates := ARRAY(
    SELECT elem::TEXT
    FROM jsonb_array_elements_text(COALESCE(v_policy->'provider_priority', '[]'::jsonb)) AS elem
    WHERE elem::TEXT NOT IN ('internal_cache', 'manual_review_virtual')
  );

  v_sequence_index := COALESCE(
    NULLIF(v_metadata->>'provider_sequence_index', '')::INT,
    0
  );

  IF array_length(v_provider_candidates, 1) IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'provider_priority_empty'
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_build_object(
        'successful', FALSE,
        'manual_review_required', TRUE,
        'manual_review_reason', 'provider_priority_exhausted'
      )
    );
    RETURN v_response;
  END IF;

  IF v_sequence_index >= array_length(v_provider_candidates, 1) THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'provider_priority_exhausted',
      'provider_sequence_index', v_sequence_index
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_build_object(
        'successful', FALSE,
        'manual_review_required', TRUE,
        'manual_review_reason', 'provider_priority_exhausted'
      )
    );
    RETURN v_response;
  END IF;

  RETURN workflow_handlers.execute_provider_dispatch_v1_base(p_step, p_run, p_operation_result);
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_provider_dispatch_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_provider_dispatch_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Provider dispatch guard: skip out-of-range provider_sequence_index and route to manual review instead of failing.';

COMMIT;
