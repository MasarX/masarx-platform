-- Migration: Geocoding policy provider fail-fast + decision wrapper
-- Purpose:
--   - Add provider_error fail-fast config to geocoding_policy schema.
--   - Allow geo decision to fail fast on provider errors (policy-driven).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-12
BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Schema: geocoding_policy v4 (provider_error.fail_fast)
-------------------------------------------------------------------------------
WITH base AS (
  SELECT schema, description, examples
  FROM public.schema_registry
  WHERE category = 'geocoding_policy'
    AND is_active = TRUE
  ORDER BY version DESC
  LIMIT 1
),
patched AS (
  SELECT
    jsonb_set(
      base.schema,
      '{properties,provider_error}',
      jsonb_build_object(
        'type', 'object',
        'additionalProperties', FALSE,
        'required', jsonb_build_array('fail_fast'),
        'properties', jsonb_build_object(
          'fail_fast', jsonb_build_object('type', 'boolean'),
          'provider_names', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object('type', 'string', 'minLength', 1)
          )
        )
      ),
      TRUE
    ) AS schema,
    base.description,
    base.examples
  FROM base
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'geocoding_policy',
  4,
  patched.schema,
  COALESCE(patched.description, 'geocoding_policy schema') || ' (v4: provider_error fail-fast)',
  patched.examples,
  TRUE
FROM patched
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

UPDATE public.schema_registry
SET is_active = CASE WHEN version = 4 THEN TRUE ELSE FALSE END
WHERE category = 'geocoding_policy';

-------------------------------------------------------------------------------
-- 2) Geo decision wrapper: fail fast on provider errors (policy-driven)
-------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('workflow_handlers.execute_geo_decision_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL
     AND to_regprocedure('workflow_handlers.execute_geo_decision_v1(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geo_decision_v1(public.workflow_run_steps, public.workflow_runs, jsonb) RENAME TO execute_geo_decision_v1_base';
  END IF;

  IF to_regprocedure('workflow_handlers.execute_geo_decision_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'execute_geo_decision_v1_base missing; cannot apply provider fail-fast wrapper';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_decision_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
  v_short_plugin JSONB := workflow_handlers.geocoding_get_plugin(v_policy, 'short_code');
  v_fail_fast_short BOOLEAN := COALESCE((v_short_plugin->'params'->>'fail_on_reverse_error')::BOOLEAN, FALSE);
  v_provider_error JSONB := COALESCE(v_policy->'provider_error', '{}'::jsonb);
  v_fail_fast_provider BOOLEAN := COALESCE((v_provider_error->>'fail_fast')::BOOLEAN, FALSE);
  v_fail_fast_names TEXT[] := NULL;
  v_ctx RECORD;
  v_short_code TEXT;
  v_attempt RECORD;
  v_response public.workflow_handler_response;
  v_match JSONB;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, pg_temp', FALSE);

  IF NOT v_fail_fast_short AND NOT v_fail_fast_provider THEN
    RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
  END IF;

  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);
  IF v_ctx.address_id IS NULL THEN
    RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
  END IF;

  SELECT *
  INTO v_attempt
  FROM public.geocoding_attempts
  WHERE address_id = v_ctx.address_id
  ORDER BY attempt_order DESC, created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
  END IF;

  v_short_code := NULLIF(p_run.context->'geocoding'->>'short_code', '');
  IF v_short_code IS NULL THEN
    SELECT NULLIF(a.sa_short_code, '')
    INTO v_short_code
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id
      AND (v_ctx.client_id IS NULL OR a.client_id = v_ctx.client_id)
    LIMIT 1;
  END IF;

  IF v_fail_fast_short AND v_short_code IS NOT NULL AND COALESCE(v_attempt.status, '') <> 'succeeded' THEN
    v_match := jsonb_strip_nulls(jsonb_build_object(
      'plugin', 'short_code',
      'match_type', 'provider_failed',
      'routing_reason', 'short_code_reverse_failed',
      'provider_name', v_attempt.provider_name,
      'status', v_attempt.status
    ));
    PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

    v_response.status := 'failed';
    v_response.workflow_status := 'failed';
    v_response.last_error := 'short_code_reverse_failed';
    v_response.operation_result := jsonb_build_object(
      'decision', 'failed',
      'reason', 'short_code_reverse_failed',
      'attempt_id', v_attempt.id,
      'provider_name', v_attempt.provider_name,
      'status', v_attempt.status
    );
    v_response.context_patch := jsonb_build_object(
      'geocoding', jsonb_strip_nulls(jsonb_build_object(
        'successful', FALSE,
        'manual_review_required', FALSE,
        'require_fallback', FALSE,
        'fail_fast', TRUE,
        'fail_reason', 'short_code_reverse_failed',
        'short_code', v_short_code,
        'selected_attempt_id', v_attempt.id,
        'selected_geocode', v_attempt.metadata->'geocode'
      ))
    );
    RETURN v_response;
  END IF;

  IF v_fail_fast_provider AND COALESCE(v_attempt.status, '') <> 'succeeded' THEN
    SELECT ARRAY(
      SELECT lower(elem::text)
      FROM jsonb_array_elements_text(COALESCE(v_provider_error->'provider_names', '[]'::jsonb)) AS elem
    ) INTO v_fail_fast_names;

    IF v_fail_fast_names IS NULL
       OR array_length(v_fail_fast_names, 1) IS NULL
       OR lower(COALESCE(v_attempt.provider_name, '')) = ANY(v_fail_fast_names) THEN
      v_match := jsonb_strip_nulls(jsonb_build_object(
        'plugin', 'provider_error',
        'match_type', 'provider_failed',
        'routing_reason', 'provider_fail_fast',
        'provider_name', v_attempt.provider_name,
        'status', v_attempt.status
      ));
      PERFORM workflow_handlers.geocoding_log_match(p_step.workflow_run_id, p_step.id, v_policy, v_match);

      v_response.status := 'failed';
      v_response.workflow_status := 'failed';
      v_response.last_error := 'provider_failed';
      v_response.operation_result := jsonb_build_object(
        'decision', 'failed',
        'reason', 'provider_failed',
        'attempt_id', v_attempt.id,
        'provider_name', v_attempt.provider_name,
        'status', v_attempt.status
      );
      v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
          'successful', FALSE,
          'manual_review_required', FALSE,
          'require_fallback', FALSE,
          'fail_fast', TRUE,
          'fail_reason', 'provider_failed',
          'selected_attempt_id', v_attempt.id,
          'selected_geocode', v_attempt.metadata->'geocode'
        ))
      );
      RETURN v_response;
    END IF;
  END IF;

  RETURN workflow_handlers.execute_geo_decision_v1_base(p_step, p_run, p_operation_result);
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_geo_decision_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path TO public, workflow_handlers, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geo_decision_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Geo decision wrapper: fail fast on short-code reverse or configured provider errors (policy-driven).';

COMMIT;
