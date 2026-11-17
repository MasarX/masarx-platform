-- Migration: Geocoding provider dispatch skip when already resolved
-- Purpose:
--   - Avoid overwriting successful local geocoding when fallback is not required.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SET search_path TO 'public', 'workflow_handlers', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
  v_attempt_type TEXT := lower(COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary'));
  v_require_fallback BOOLEAN := COALESCE((p_run.context->'geocoding'->>'require_fallback')::BOOLEAN, FALSE);
  v_already_resolved BOOLEAN := COALESCE((p_run.context->'geocoding'->>'successful')::BOOLEAN, FALSE);
  v_provider_candidates TEXT[];
  v_sequence_index INT;
  v_response public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);

  IF v_already_resolved AND NOT v_require_fallback THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'geocoding_already_resolved'
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_build_object(
        'provider_dispatch_skipped', TRUE
      )
    );
    RETURN v_response;
  END IF;

  IF v_attempt_type = 'fallback' AND NOT v_require_fallback THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE,
      'reason', 'fallback_not_required'
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_build_object(
        'fallback_skipped', TRUE
      )
    );
    RETURN v_response;
  END IF;

  v_provider_candidates := ARRAY(
    SELECT elem::TEXT
    FROM jsonb_array_elements_text(COALESCE(v_policy->'provider_priority', '[]'::jsonb)) AS elem
    WHERE elem::TEXT NOT IN ('internal_cache', 'manual_review_virtual')
  );

  v_sequence_index := COALESCE(NULLIF(v_metadata->>'provider_sequence_index', '')::INT, 0);

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

COMMIT;
