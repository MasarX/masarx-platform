-- Migration: ui_get_workflow_run_output_status_v7 async bundle reconciliation
-- Purpose:
--   - Let interactive workflow status polling reconcile completed label bundle async responses back into the workflow immediately.
--   - Keep workflow/output SSOT aligned without depending on minute-scale background progression.
--   - Preserve fresh-only semantics and existing output-source fallback behavior.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603062130_ui_get_workflow_run_output_status_v7_async_reconcile'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_get_workflow_run_output_status_v1(
  p_workflow_run_id UUID,
  p_output_url_paths TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_run RECORD;
  v_context JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
  v_step_result JSONB := '{}'::jsonb;
  v_detail JSONB := '{}'::jsonb;
  v_path TEXT;
  v_segments TEXT[];
  v_value TEXT;
  v_output_url TEXT := NULL;
  v_output_source TEXT := NULL;
  v_default_paths TEXT[] := ARRAY[
      'context.generated_labels[0].download_url',
      'context.generated_labels[0].url',
      'context.outputs[0].download_url',
      'context.outputs[0].url',
      'context.output.url',
      'context.label_print.bundle_response.signed_url',
      'context.label_print.bundle_response.file_url',
      'metadata.generated_labels[0].download_url',
      'metadata.generated_labels[0].url',
      'metadata.outputs[0].download_url',
      'metadata.outputs[0].url',
      'metadata.output.url',
      'metadata.label_print.bundle_response.signed_url',
      'metadata.label_print.bundle_response.file_url',
      'step_result.signed_url',
      'step_result.output_url',
      'step_result.file_url',
      'step_result.bundle.signed_url',
      'step_result.bundle.output_url',
      'step_result.bundle.file_url',
      'async_body.bundle.signed_url',
      'async_body.bundle.output_url',
      'async_body.bundle.file_url',
      'async_body.bundle.output_file_url',
      'async_body.signed_url',
      'async_body.output_url',
      'async_response.body.bundle.signed_url',
      'async_response.body.bundle.output_url',
      'async_response.body.bundle.file_url',
      'async_response.body.bundle.output_file_url',
      'async_response.body.signed_url',
      'async_response.body.output_url'
    ]::TEXT[];
  v_paths TEXT[] := NULL;
  v_pending_text TEXT := '';
  v_ready_text TEXT := '';
  v_pending_count INT := NULL;
  v_ready_count INT := NULL;
  v_phase TEXT := 'checking';
  v_terminal BOOLEAN := FALSE;
  v_failure_reason TEXT := NULL;
  v_run_org_raw TEXT := '';
  v_run_org_id UUID := NULL;
  v_status_checked_at TIMESTAMPTZ := now();
  v_function_total_raw TEXT := '';
  v_function_total_ms NUMERIC := NULL;
  v_async_request_raw TEXT := '';
  v_async_request_id BIGINT := NULL;
  v_async_response JSONB := '{}'::jsonb;
  v_async_body JSONB := '{}'::jsonb;
  v_async_completed BOOLEAN := FALSE;
  v_reload_attempt INT := 0;
  v_bundle_response JSONB := '{}'::jsonb;
  v_bundle_step_id UUID := NULL;
  v_bundle_step_raw TEXT := '';
  v_bundle_progress_budget_ms INT := 1200;
  v_bundle_progress_max_steps INT := 10;
  v_bundle_progress_result JSONB := NULL;
  v_bundle_progress_attempted BOOLEAN := FALSE;
  v_bundle_progress_status TEXT := NULL;
  v_bundle_progress_error TEXT := NULL;
  v_bundle_payload JSONB := '{}'::jsonb;
  v_bundle_step_status TEXT := NULL;
BEGIN
  v_paths := CASE
    WHEN p_output_url_paths IS NULL OR array_length(p_output_url_paths, 1) IS NULL THEN v_default_paths
    ELSE p_output_url_paths || v_default_paths
  END;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 requires authenticated user';
  END IF;
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 requires workflow_run_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.read', v_scope_type, v_scope_id);

  <<reload_run>>
  FOR v_reload_attempt IN 1..2 LOOP
    SELECT
      wr.id,
      wr.workflow_status,
      wr.context,
      wr.metadata,
      wr.failure_reason,
      wr.last_error,
      wts.operation_name AS current_operation
    INTO v_run
    FROM public.workflow_runs wr
    LEFT JOIN public.workflow_template_steps wts ON wts.id = wr.current_step_id
    WHERE wr.id = p_workflow_run_id
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 workflow_run not found %', p_workflow_run_id;
    END IF;

    v_context := COALESCE(v_run.context, '{}'::jsonb);
    v_metadata := COALESCE(v_run.metadata, '{}'::jsonb);

    SELECT COALESCE(wrs.operation_result->'bundle', wrs.operation_result, '{}'::jsonb)
    INTO v_step_result
    FROM public.workflow_run_steps wrs
    WHERE wrs.workflow_run_id = p_workflow_run_id
      AND wrs.handler_key IN ('label_print_finalize', 'label_bundle')
    ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
    LIMIT 1;

    v_run_org_raw := COALESCE(v_context->>'organization_id', '');
    IF v_run_org_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_run_org_id := v_run_org_raw::UUID;
    ELSE
      v_run_org_id := NULL;
    END IF;

    IF NOT public.is_platform_user() THEN
      IF v_org_id IS NULL OR v_run_org_id IS NULL OR v_run_org_id IS DISTINCT FROM v_org_id THEN
        RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 access denied for workflow_run %', p_workflow_run_id;
      END IF;
    END IF;

    v_async_request_raw := COALESCE(
      NULLIF(v_context #>> '{label_print,bundle_async,request_id}', ''),
      NULLIF(v_metadata #>> '{label_print,bundle_async,request_id}', '')
    );
    v_async_request_id := NULL;
    v_async_response := '{}'::jsonb;
    v_async_body := '{}'::jsonb;
    v_async_completed := FALSE;

    IF v_async_request_raw ~ '^[0-9]+$' THEN
      v_async_request_id := v_async_request_raw::BIGINT;
      BEGIN
        v_async_response := COALESCE(public.check_async_response(v_async_request_id), '{}'::jsonb);
        v_async_completed := COALESCE((v_async_response->>'completed')::BOOLEAN, FALSE);
        IF jsonb_typeof(v_async_response->'body') = 'object' THEN
          v_async_body := v_async_response->'body';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_async_response := '{}'::jsonb;
        v_async_body := '{}'::jsonb;
        v_async_completed := FALSE;
      END;
    END IF;

    v_bundle_response := COALESCE(v_context #> '{label_print,bundle_response}', '{}'::jsonb);

    IF v_reload_attempt = 1
       AND v_async_request_id IS NOT NULL
       AND v_async_completed
       AND NOT v_bundle_progress_attempted
       AND COALESCE(jsonb_typeof(v_bundle_response), '') = 'object'
       AND v_bundle_response = '{}'::jsonb THEN
      v_bundle_step_raw := COALESCE(
        NULLIF(v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_run_step_id}', ''),
        NULLIF(v_metadata #>> '{label_print,bundle_async,request_payload,bundle,workflow_run_step_id}', '')
      );
      IF v_bundle_step_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        v_bundle_step_id := v_bundle_step_raw::UUID;
      ELSE
        SELECT wrs.id
        INTO v_bundle_step_id
        FROM public.workflow_run_steps wrs
        WHERE wrs.workflow_run_id = p_workflow_run_id
          AND wrs.handler_key = 'label_bundle'
        ORDER BY wrs.sequence_order DESC
        LIMIT 1;
      END IF;

      IF COALESCE(v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_progress_budget_ms}', '') ~ '^\d+$' THEN
        v_bundle_progress_budget_ms := LEAST(
          GREATEST((v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_progress_budget_ms}')::INT, 25),
          5000
        );
      END IF;
      IF COALESCE(v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_progress_max_steps}', '') ~ '^\d+$' THEN
        v_bundle_progress_max_steps := LEAST(
          GREATEST((v_context #>> '{label_print,bundle_async,request_payload,bundle,workflow_progress_max_steps}')::INT, 1),
          50
        );
      END IF;

      IF v_bundle_step_id IS NOT NULL THEN
        SELECT wrs.step_status
        INTO v_bundle_step_status
        FROM public.workflow_run_steps wrs
        WHERE wrs.id = v_bundle_step_id
          AND wrs.workflow_run_id = p_workflow_run_id
        LIMIT 1;

        IF v_bundle_step_status = 'pending' THEN
          v_bundle_payload := COALESCE(v_async_body->'bundle', v_async_body, '{}'::jsonb);
          v_bundle_progress_attempted := TRUE;
          BEGIN
            v_bundle_progress_result := public.progress_workflow_run_step_result_v1(
              p_workflow_run_id,
              v_bundle_step_id,
              jsonb_strip_nulls(jsonb_build_object(
                'status', CASE
                  WHEN lower(COALESCE(v_bundle_payload->>'status', v_async_body->>'status', '')) IN ('failed', 'error')
                       OR NULLIF(v_async_body->>'error', '') IS NOT NULL
                  THEN 'failed'
                  ELSE 'completed'
                END,
                'source', 'ui_status_bundle_async_reconcile',
                'bundle', v_bundle_payload
              )),
              v_bundle_progress_budget_ms,
              v_bundle_progress_max_steps
            );
            v_bundle_progress_status := NULLIF(v_bundle_progress_result->>'status', '');
          EXCEPTION
            WHEN OTHERS THEN
              v_bundle_progress_error := SQLERRM;
          END;
        END IF;
      END IF;

      CONTINUE reload_run;
    END IF;

    EXIT reload_run;
  END LOOP;

  v_detail := jsonb_build_object(
    'context', v_context,
    'metadata', v_metadata,
    'step_result', COALESCE(v_step_result, '{}'::jsonb),
    'async_response', COALESCE(v_async_response, '{}'::jsonb),
    'async_body', COALESCE(v_async_body, '{}'::jsonb)
  );

  FOREACH v_path IN ARRAY v_paths LOOP
    v_path := btrim(COALESCE(v_path, ''));
    IF v_path = '' THEN
      CONTINUE;
    END IF;

    v_segments := string_to_array(regexp_replace(v_path, '\\[(\\d+)\\]', '.\\1', 'g'), '.');
    IF v_segments IS NULL OR array_length(v_segments, 1) IS NULL THEN
      CONTINUE;
    END IF;

    v_value := NULLIF(btrim(v_detail #>> v_segments), '');
    IF v_value ~* '^https?://' THEN
      v_output_url := v_value;
      IF v_path LIKE 'context.%' THEN
        v_output_source := 'context';
      ELSIF v_path LIKE 'metadata.%' THEN
        v_output_source := 'metadata';
      ELSIF v_path LIKE 'step_result.%' THEN
        v_output_source := 'step_result';
      ELSIF v_path LIKE 'async_body.%' OR v_path LIKE 'async_response.%' THEN
        v_output_source := 'async_response';
      ELSE
        v_output_source := 'unknown';
      END IF;
      EXIT;
    END IF;
  END LOOP;

  v_pending_text := COALESCE(v_context #>> '{label_print,counts,pending}', '');
  IF v_pending_text ~ '^\\d+$' THEN
    v_pending_count := v_pending_text::INT;
  END IF;

  v_ready_text := COALESCE(v_context #>> '{label_print,counts,ready}', '');
  IF v_ready_text ~ '^\\d+$' THEN
    v_ready_count := v_ready_text::INT;
  END IF;

  v_terminal := COALESCE(v_run.workflow_status, '') IN ('completed', 'failed', 'cancelled');
  IF v_output_url IS NULL AND v_terminal AND v_async_request_id IS NOT NULL AND NOT v_async_completed THEN
    v_terminal := FALSE;
  END IF;

  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_phase := 'failed';
  ELSIF v_output_url IS NOT NULL THEN
    v_phase := 'downloading';
  ELSIF v_async_request_id IS NOT NULL AND NOT v_async_completed THEN
    v_phase := 'bundling';
  ELSIF COALESCE(v_run.current_operation, '') = 'label_print_prepare' THEN
    v_phase := 'generating';
  ELSIF COALESCE(v_run.current_operation, '') IN ('label_bundle', 'label_print_finalize') THEN
    v_phase := 'bundling';
  ELSE
    v_phase := 'checking';
  END IF;

  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_failure_reason := COALESCE(
      NULLIF(v_run.failure_reason, ''),
      NULLIF(v_run.last_error::TEXT, ''),
      format('workflow_status=%s', v_run.workflow_status)
    );
  ELSIF COALESCE(v_run.workflow_status, '') = 'completed' AND v_output_url IS NULL THEN
    IF v_async_request_id IS NOT NULL AND NOT v_async_completed THEN
      v_failure_reason := NULL;
    ELSIF NULLIF(v_async_body->>'error', '') IS NOT NULL THEN
      v_failure_reason := format('bundle_async_error: %s', v_async_body->>'error');
    ELSE
      v_failure_reason := 'workflow completed without output URL';
    END IF;
  END IF;

  v_function_total_raw := COALESCE(
    NULLIF(v_step_result #>> '{timings,total_ms}', ''),
    NULLIF(v_step_result #>> '{bundle,timings,total_ms}', ''),
    NULLIF(v_context #>> '{label_print,bundle_response,timings,total_ms}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_response,timings,total_ms}', ''),
    NULLIF(v_async_body #>> '{timings,total_ms}', ''),
    NULLIF(v_async_body #>> '{bundle,timings,total_ms}', '')
  );
  BEGIN
    IF NULLIF(v_function_total_raw, '') IS NOT NULL THEN
      v_function_total_ms := v_function_total_raw::NUMERIC;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_function_total_ms := NULL;
  END;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', v_run.id,
    'workflow_status', v_run.workflow_status,
    'current_operation', v_run.current_operation,
    'phase', v_phase,
    'output_url', v_output_url,
    'output_source', v_output_source,
    'output_ready', v_output_url IS NOT NULL,
    'terminal', v_terminal,
    'failure_reason', v_failure_reason,
    'pending_count', v_pending_count,
    'ready_count', v_ready_count,
    'bundle_async_request_id', v_async_request_id,
    'bundle_async_completed', v_async_completed,
    'function_total_ms', v_function_total_ms,
    'status_checked_at', v_status_checked_at,
    'async_progress_attempted', CASE WHEN v_bundle_progress_attempted THEN TRUE ELSE NULL END,
    'async_progress_status', v_bundle_progress_status,
    'async_progress_error', v_bundle_progress_error
  ));
END;
$$;

CREATE OR REPLACE FUNCTION api.ui_get_workflow_run_output_status_v1(
  p_workflow_run_id UUID,
  p_output_url_paths TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_get_workflow_run_output_status_v1(p_workflow_run_id, p_output_url_paths);
$$;

SELECT pg_advisory_unlock(hashtext('202603062130_ui_get_workflow_run_output_status_v7_async_reconcile'));
COMMIT;
