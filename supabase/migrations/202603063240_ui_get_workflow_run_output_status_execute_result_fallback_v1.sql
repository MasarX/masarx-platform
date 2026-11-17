-- Migration: ui workflow output status execute result fallback
-- Purpose:
--   - Prefer the completed execute step result when workflow context still contains a stale pending execute_response object.
--   - Let status polling surface current output readiness from the canonical execute step as soon as it is written.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063240_ui_get_workflow_run_output_status_execute_result_fallback_v1'));
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
  v_output_file_path TEXT := NULL;
  v_output_bucket TEXT := 'labels';
  v_output_needs_signing BOOLEAN := FALSE;
  v_output_source TEXT := NULL;
  v_default_paths TEXT[] := ARRAY[
      'context.generated_labels[0].download_url',
      'context.generated_labels[0].url',
      'context.outputs[0].download_url',
      'context.outputs[0].url',
      'context.output.url',
      'context.label_print.execute_response.bundle.signed_url',
      'context.label_print.execute_response.bundle.file_url',
      'context.label_print.bundle_response.signed_url',
      'context.label_print.bundle_response.file_url',
      'metadata.generated_labels[0].download_url',
      'metadata.generated_labels[0].url',
      'metadata.outputs[0].download_url',
      'metadata.outputs[0].url',
      'metadata.output.url',
      'metadata.label_print.execute_response.bundle.signed_url',
      'metadata.label_print.execute_response.bundle.file_url',
      'metadata.label_print.bundle_response.signed_url',
      'metadata.label_print.bundle_response.file_url',
      'execute_result.bundle.signed_url',
      'execute_result.bundle.output_url',
      'execute_result.bundle.file_url',
      'step_result.signed_url',
      'step_result.output_url',
      'step_result.file_url',
      'step_result.execute.bundle.signed_url',
      'step_result.execute.bundle.output_url',
      'step_result.execute.bundle.file_url',
      'step_result.bundle.signed_url',
      'step_result.bundle.output_url',
      'step_result.bundle.file_url',
      'step_result.bundle.output_file_url',
      'execute_async_body.bundle.signed_url',
      'execute_async_body.bundle.output_url',
      'execute_async_body.bundle.file_url',
      'execute_async_body.bundle.output_file_url',
      'execute_async_response.body.bundle.signed_url',
      'execute_async_response.body.bundle.output_url',
      'execute_async_response.body.bundle.file_url',
      'execute_async_response.body.bundle.output_file_url',
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
  v_fresh_paths TEXT[] := ARRAY[
      'context.label_print.execute_response.bundle.signed_url',
      'context.label_print.execute_response.bundle.file_url',
      'context.label_print.bundle_response.signed_url',
      'context.label_print.bundle_response.file_url',
      'metadata.label_print.execute_response.bundle.signed_url',
      'metadata.label_print.execute_response.bundle.file_url',
      'metadata.label_print.bundle_response.signed_url',
      'metadata.label_print.bundle_response.file_url',
      'execute_result.bundle.signed_url',
      'execute_result.bundle.output_url',
      'execute_result.bundle.file_url',
      'step_result.signed_url',
      'step_result.output_url',
      'step_result.file_url',
      'step_result.execute.bundle.signed_url',
      'step_result.execute.bundle.output_url',
      'step_result.execute.bundle.file_url',
      'step_result.bundle.signed_url',
      'step_result.bundle.output_url',
      'step_result.bundle.file_url',
      'step_result.bundle.output_file_url',
      'execute_async_body.bundle.signed_url',
      'execute_async_body.bundle.output_url',
      'execute_async_body.bundle.file_url',
      'execute_async_body.bundle.output_file_url',
      'execute_async_response.body.bundle.signed_url',
      'execute_async_response.body.bundle.output_url',
      'execute_async_response.body.bundle.file_url',
      'execute_async_response.body.bundle.output_file_url',
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
  v_file_path_paths TEXT[] := ARRAY[
      'context.label_print.execute_response.bundle.file_path',
      'context.label_print.bundle_response.file_path',
      'metadata.label_print.execute_response.bundle.file_path',
      'metadata.label_print.bundle_response.file_path',
      'execute_result.bundle.file_path',
      'step_result.execute.bundle.file_path',
      'step_result.file_path',
      'step_result.bundle.file_path',
      'execute_async_body.bundle.file_path',
      'execute_async_response.body.bundle.file_path',
      'async_body.bundle.file_path',
      'async_response.body.bundle.file_path'
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
  v_status_checked_at TIMESTAMPTZ := clock_timestamp();
  v_function_total_raw TEXT := '';
  v_function_total_ms NUMERIC := NULL;
  v_execute_result JSONB := '{}'::jsonb;
  v_execute_request_raw TEXT := '';
  v_execute_request_id BIGINT := NULL;
  v_execute_async_response JSONB := '{}'::jsonb;
  v_execute_async_body JSONB := '{}'::jsonb;
  v_execute_async_completed BOOLEAN := FALSE;
  v_execute_step_id UUID := NULL;
  v_execute_step_raw TEXT := '';
  v_execute_step_status TEXT := NULL;
  v_execute_progress_result JSONB := NULL;
  v_execute_progress_attempted BOOLEAN := FALSE;
  v_execute_progress_status TEXT := NULL;
  v_execute_progress_error TEXT := NULL;
  v_async_request_raw TEXT := '';
  v_async_request_id BIGINT := NULL;
  v_async_response JSONB := '{}'::jsonb;
  v_async_body JSONB := '{}'::jsonb;
  v_async_completed BOOLEAN := FALSE;
  v_fresh_generation_required BOOLEAN := FALSE;
  v_fresh_resolve_mode TEXT := '';
  v_fresh_scope_key_raw TEXT := '';
  v_fresh_scope_step_id UUID := NULL;
  v_fresh_state JSONB := '{}'::jsonb;
  v_fresh_expected_count INT := 0;
  v_fresh_ready_count INT := 0;
  v_fresh_failed_count INT := 0;
  v_fresh_only_resolved BOOLEAN := FALSE;
  v_stage_prepare_ms NUMERIC := NULL;
  v_stage_execute_ms NUMERIC := NULL;
  v_stage_enqueue_ms NUMERIC := NULL;
  v_stage_render_ms NUMERIC := NULL;
  v_stage_bundle_ms NUMERIC := NULL;
  v_stage_complete_ms NUMERIC := NULL;
  v_stage_render_wait_ms NUMERIC := NULL;
  v_stage_bundle_wait_ms NUMERIC := NULL;
  v_stage_finalize_ms NUMERIC := NULL;
  v_ready_source TEXT := NULL;
  v_prepare_duration_raw TEXT := '';
  v_execute_duration_raw TEXT := '';
  v_bundle_duration_raw TEXT := '';
  v_finalize_duration_raw TEXT := '';
  v_bundle_requested_raw TEXT := '';
  v_bundle_requested_count INT := NULL;
  v_bundle_bundled_raw TEXT := '';
  v_bundle_bundled_count INT := NULL;
  v_bundle_request_label_count INT := NULL;
  v_bundle_response JSONB := '{}'::jsonb;
  v_bundle_step_id UUID := NULL;
  v_bundle_step_raw TEXT := '';
  v_bundle_step_status TEXT := NULL;
  v_bundle_progress_budget_ms INT := 1200;
  v_bundle_progress_max_steps INT := 10;
  v_bundle_progress_result JSONB := NULL;
  v_bundle_progress_attempted BOOLEAN := FALSE;
  v_bundle_progress_status TEXT := NULL;
  v_bundle_progress_error TEXT := NULL;
  v_bundle_payload JSONB := '{}'::jsonb;
  v_poll_progress_enabled BOOLEAN := FALSE;
  v_poll_progress_budget_ms INT := 350;
  v_poll_progress_max_steps INT := 8;
  v_poll_progress_result JSONB := NULL;
  v_poll_progress_attempted BOOLEAN := FALSE;
  v_poll_progress_status TEXT := NULL;
  v_poll_progress_error TEXT := NULL;
  v_poll_progress_managed BOOLEAN := FALSE;
  v_print_mode TEXT := NULL;
  v_artifact_kind TEXT := NULL;
  v_reload_attempt INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 requires authenticated user';
  END IF;
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 requires workflow_run_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.read', v_scope_type, v_scope_id);

  <<reload_run>>
  FOR v_reload_attempt IN 1..4 LOOP
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

    IF lower(COALESCE(NULLIF(v_context #>> '{ui_command,params,poll_progress_enabled}', ''), '')) IN ('1', 't', 'true', 'y', 'yes', 'on') THEN
      v_poll_progress_enabled := TRUE;
    ELSE
      v_poll_progress_enabled := FALSE;
    END IF;
    v_poll_progress_managed := v_poll_progress_enabled;

    IF COALESCE(v_context #>> '{ui_command,params,poll_progress_budget_ms}', '') ~ '^\d+$' THEN
      v_poll_progress_budget_ms := LEAST(
        GREATEST((v_context #>> '{ui_command,params,poll_progress_budget_ms}')::INT, 25),
        5000
      );
    END IF;
    IF COALESCE(v_context #>> '{ui_command,params,poll_progress_max_steps}', '') ~ '^\d+$' THEN
      v_poll_progress_max_steps := LEAST(
        GREATEST((v_context #>> '{ui_command,params,poll_progress_max_steps}')::INT, 1),
        50
      );
    END IF;

    IF v_reload_attempt = 1
       AND v_poll_progress_enabled
       AND COALESCE(v_run.workflow_status, '') NOT IN ('completed', 'failed', 'cancelled')
       AND NOT v_poll_progress_attempted THEN
      BEGIN
        v_poll_progress_result := public.progress_workflow_run_until_wait_v1(
          p_workflow_run_id,
          '{}'::jsonb,
          v_poll_progress_budget_ms,
          v_poll_progress_max_steps
        );
        v_poll_progress_attempted := TRUE;
        v_poll_progress_status := NULLIF(v_poll_progress_result->>'status', '');
      EXCEPTION
        WHEN OTHERS THEN
          v_poll_progress_attempted := TRUE;
          v_poll_progress_error := SQLERRM;
      END;
      CONTINUE reload_run;
    END IF;

    SELECT COALESCE(wrs.operation_result, '{}'::jsonb)
    INTO v_step_result
    FROM public.workflow_run_steps wrs
    WHERE wrs.workflow_run_id = p_workflow_run_id
      AND wrs.handler_key IN ('label_print_finalize', 'label_print_execute', 'label_bundle')
    ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
    LIMIT 1;

    v_execute_result := COALESCE(v_context #> '{label_print,execute_response}', '{}'::jsonb);
    IF COALESCE(jsonb_typeof(v_execute_result), '') IS DISTINCT FROM 'object'
       OR v_execute_result = '{}'::jsonb
       OR lower(COALESCE(NULLIF(v_execute_result->>'status', ''), 'pending')) IN ('pending', 'waiting', 'in_progress')
       OR COALESCE(
         NULLIF(v_execute_result #>> '{bundle,signed_url}', ''),
         NULLIF(v_execute_result #>> '{bundle,output_url}', ''),
         NULLIF(v_execute_result #>> '{bundle,file_url}', ''),
         NULLIF(v_execute_result #>> '{bundle,output_file_url}', ''),
         NULLIF(v_execute_result #>> '{bundle,file_path}', '')
       ) IS NULL THEN
      SELECT COALESCE(
               CASE
                 WHEN jsonb_typeof(wrs.operation_result->'execute') = 'object' THEN wrs.operation_result->'execute'
                 ELSE wrs.operation_result
               END,
               '{}'::jsonb
             )
      INTO v_execute_result
      FROM public.workflow_run_steps wrs
      WHERE wrs.workflow_run_id = p_workflow_run_id
        AND wrs.handler_key = 'label_print_execute'
      ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
      LIMIT 1;
    END IF;

    v_execute_request_raw := COALESCE(
      NULLIF(v_context #>> '{label_print,execute_async,request_id}', ''),
      NULLIF(v_metadata #>> '{label_print,execute_async,request_id}', '')
    );
    v_execute_request_id := NULL;
    v_execute_async_response := '{}'::jsonb;
    v_execute_async_body := '{}'::jsonb;
    v_execute_async_completed := FALSE;

    IF v_execute_request_raw ~ '^[0-9]+$' THEN
      v_execute_request_id := v_execute_request_raw::BIGINT;
      BEGIN
        v_execute_async_response := COALESCE(public.check_async_response(v_execute_request_id), '{}'::jsonb);
        v_execute_async_completed := COALESCE((v_execute_async_response->>'completed')::BOOLEAN, FALSE);
        IF jsonb_typeof(v_execute_async_response->'body') = 'object' THEN
          v_execute_async_body := v_execute_async_response->'body';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_execute_async_response := '{}'::jsonb;
        v_execute_async_body := '{}'::jsonb;
        v_execute_async_completed := FALSE;
      END;
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
    IF COALESCE(jsonb_typeof(v_bundle_response), '') IS DISTINCT FROM 'object' OR v_bundle_response = '{}'::jsonb THEN
      v_bundle_response := COALESCE(
        CASE WHEN jsonb_typeof(v_execute_result->'bundle') = 'object' THEN v_execute_result->'bundle' ELSE NULL END,
        CASE WHEN jsonb_typeof(v_step_result->'bundle') = 'object' THEN v_step_result->'bundle' ELSE NULL END,
        '{}'::jsonb
      );
    END IF;

    IF v_reload_attempt <= 3
       AND v_execute_request_id IS NOT NULL
       AND v_execute_async_completed
       AND NOT v_execute_progress_attempted
       AND (
         COALESCE(jsonb_typeof(v_execute_result), '') IS DISTINCT FROM 'object'
         OR v_execute_result = '{}'::jsonb
         OR lower(COALESCE(NULLIF(v_execute_result->>'status', ''), 'pending')) IN ('pending', 'waiting', 'in_progress')
         OR COALESCE(
           NULLIF(v_execute_result #>> '{bundle,signed_url}', ''),
           NULLIF(v_execute_result #>> '{bundle,output_url}', ''),
           NULLIF(v_execute_result #>> '{bundle,file_url}', ''),
           NULLIF(v_execute_result #>> '{bundle,output_file_url}', ''),
           NULLIF(v_execute_result #>> '{bundle,file_path}', '')
         ) IS NULL
       ) THEN
      v_execute_step_raw := COALESCE(
        NULLIF(v_context #>> '{label_print,execute_async,request_payload,print,workflow_run_step_id}', ''),
        NULLIF(v_metadata #>> '{label_print,execute_async,request_payload,print,workflow_run_step_id}', ''),
        NULLIF(v_context #>> '{label_print,fresh_request_scope_key}', ''),
        NULLIF(v_metadata #>> '{label_print,fresh_request_scope_key}', '')
      );
      IF v_execute_step_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        v_execute_step_id := v_execute_step_raw::UUID;
      ELSE
        SELECT wrs.id
        INTO v_execute_step_id
        FROM public.workflow_run_steps wrs
        WHERE wrs.workflow_run_id = p_workflow_run_id
          AND wrs.handler_key = 'label_print_execute'
        ORDER BY wrs.sequence_order DESC
        LIMIT 1;
      END IF;

      IF v_execute_step_id IS NOT NULL THEN
        SELECT wrs.step_status
        INTO v_execute_step_status
        FROM public.workflow_run_steps wrs
        WHERE wrs.id = v_execute_step_id
          AND wrs.workflow_run_id = p_workflow_run_id
        LIMIT 1;

        IF v_execute_step_status = 'pending' THEN
          v_execute_progress_attempted := TRUE;
          BEGIN
            v_execute_progress_result := public.progress_workflow_run_step_result_v1(
              p_workflow_run_id,
              v_execute_step_id,
              jsonb_strip_nulls(jsonb_build_object(
                'status', CASE
                  WHEN lower(COALESCE(v_execute_async_body->>'status', '')) IN ('failed', 'error')
                       OR NULLIF(v_execute_async_body->>'error', '') IS NOT NULL
                  THEN 'failed'
                  ELSE 'completed'
                END,
                'source', 'ui_status_execute_async_reconcile',
                'print_mode', COALESCE(NULLIF(v_execute_async_body->>'mode', ''), 'print_sync'),
                'artifact_kind', COALESCE(NULLIF(v_execute_async_body->>'artifact_kind', ''), NULLIF(v_execute_async_body #>> '{bundle,artifact_kind}', '')),
                'execute', v_execute_async_body,
                'bundle', CASE
                  WHEN jsonb_typeof(v_execute_async_body->'bundle') = 'object' THEN v_execute_async_body->'bundle'
                  ELSE NULL
                END
              )),
              v_poll_progress_budget_ms,
              v_poll_progress_max_steps
            );
            v_execute_progress_status := NULLIF(v_execute_progress_result->>'status', '');
          EXCEPTION
            WHEN OTHERS THEN
              v_execute_progress_error := SQLERRM;
          END;
          CONTINUE reload_run;
        END IF;
      END IF;
    END IF;

    IF v_reload_attempt <= 3
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
          CONTINUE reload_run;
        END IF;
      END IF;
    END IF;

    EXIT reload_run;
  END LOOP;

  v_fresh_generation_required := COALESCE((v_context #>> '{label_print,fresh_generation_required}')::BOOLEAN, FALSE);
  v_fresh_resolve_mode := lower(COALESCE(NULLIF(v_context #>> '{label_print,fresh_resolve_mode}', ''), ''));
  v_fresh_scope_key_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,fresh_request_scope_key}', ''),
    NULLIF(v_metadata #>> '{label_print,fresh_request_scope_key}', '')
  );
  IF v_fresh_scope_key_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_fresh_scope_step_id := v_fresh_scope_key_raw::uuid;
  END IF;

  IF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' AND v_fresh_scope_step_id IS NOT NULL THEN
    v_fresh_state := public.resolve_label_print_fresh_scope_v1(
      v_fresh_scope_step_id,
      COALESCE(v_context->'label_print'->'targets', v_metadata->'label_print'->'targets', '[]'::jsonb)
    );
    v_fresh_expected_count := COALESCE(NULLIF(v_fresh_state->>'expected_count', '')::INT, 0);
    v_fresh_ready_count := COALESCE(NULLIF(v_fresh_state->>'ready_count', '')::INT, 0);
    v_fresh_failed_count := COALESCE(NULLIF(v_fresh_state->>'failed_count', '')::INT, 0);
    v_pending_count := COALESCE(NULLIF(v_fresh_state->>'pending_count', '')::INT, 0);
    v_ready_count := v_fresh_ready_count;
    v_fresh_only_resolved := TRUE;
  ELSE
    v_pending_text := COALESCE(v_context #>> '{label_print,counts,pending}', '');
    IF v_pending_text ~ '^\d+$' THEN
      v_pending_count := v_pending_text::INT;
    END IF;

    v_ready_text := COALESCE(v_context #>> '{label_print,counts,ready}', '');
    IF v_ready_text ~ '^\d+$' THEN
      v_ready_count := v_ready_text::INT;
    END IF;
  END IF;

  v_detail := jsonb_build_object(
    'context', v_context,
    'metadata', v_metadata,
    'execute_result', COALESCE(v_execute_result, '{}'::jsonb),
    'step_result', COALESCE(v_step_result, '{}'::jsonb),
    'execute_async_response', COALESCE(v_execute_async_response, '{}'::jsonb),
    'execute_async_body', COALESCE(v_execute_async_body, '{}'::jsonb),
    'async_response', COALESCE(v_async_response, '{}'::jsonb),
    'async_body', COALESCE(v_async_body, '{}'::jsonb)
  );

  v_paths := CASE
    WHEN v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' THEN v_fresh_paths
    WHEN p_output_url_paths IS NULL OR array_length(p_output_url_paths, 1) IS NULL THEN v_default_paths
    ELSE p_output_url_paths || v_default_paths
  END;

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
      ELSIF v_path LIKE 'execute_result.%' THEN
        v_output_source := 'execute_result';
      ELSIF v_path LIKE 'step_result.%' THEN
        v_output_source := 'step_result';
      ELSIF v_path LIKE 'execute_async_body.%' OR v_path LIKE 'execute_async_response.%' THEN
        v_output_source := 'execute_async_response';
      ELSIF v_path LIKE 'async_body.%' OR v_path LIKE 'async_response.%' THEN
        v_output_source := 'async_response';
      ELSE
        v_output_source := 'unknown';
      END IF;
      EXIT;
    END IF;
  END LOOP;

  v_bundle_requested_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,execute_response,bundle,counts,requested}', ''),
    NULLIF(v_context #>> '{label_print,bundle_response,counts,requested}', ''),
    NULLIF(v_metadata #>> '{label_print,execute_response,bundle,counts,requested}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_response,counts,requested}', ''),
    NULLIF(v_execute_result #>> '{bundle,counts,requested}', ''),
    NULLIF(v_step_result #>> '{counts,requested}', ''),
    NULLIF(v_step_result #>> '{execute,bundle,counts,requested}', ''),
    NULLIF(v_step_result #>> '{bundle,counts,requested}', ''),
    NULLIF(v_execute_async_body #>> '{counts,requested}', ''),
    NULLIF(v_execute_async_body #>> '{bundle,counts,requested}', ''),
    NULLIF(v_execute_async_response #>> '{body,counts,requested}', ''),
    NULLIF(v_execute_async_response #>> '{body,bundle,counts,requested}', ''),
    NULLIF(v_async_body #>> '{counts,requested}', ''),
    NULLIF(v_async_body #>> '{bundle,counts,requested}', ''),
    NULLIF(v_async_response #>> '{body,counts,requested}', ''),
    NULLIF(v_async_response #>> '{body,bundle,counts,requested}', '')
  );
  IF v_bundle_requested_raw ~ '^\d+$' THEN
    v_bundle_requested_count := v_bundle_requested_raw::INT;
  END IF;

  v_bundle_bundled_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,execute_response,bundle,counts,bundled}', ''),
    NULLIF(v_context #>> '{label_print,bundle_response,counts,bundled}', ''),
    NULLIF(v_metadata #>> '{label_print,execute_response,bundle,counts,bundled}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_response,counts,bundled}', ''),
    NULLIF(v_execute_result #>> '{bundle,counts,bundled}', ''),
    NULLIF(v_step_result #>> '{counts,bundled}', ''),
    NULLIF(v_step_result #>> '{execute,bundle,counts,bundled}', ''),
    NULLIF(v_step_result #>> '{bundle,counts,bundled}', ''),
    NULLIF(v_execute_async_body #>> '{counts,bundled}', ''),
    NULLIF(v_execute_async_body #>> '{bundle,counts,bundled}', ''),
    NULLIF(v_execute_async_response #>> '{body,counts,bundled}', ''),
    NULLIF(v_execute_async_response #>> '{body,bundle,counts,bundled}', ''),
    NULLIF(v_async_body #>> '{counts,bundled}', ''),
    NULLIF(v_async_body #>> '{bundle,counts,bundled}', ''),
    NULLIF(v_async_response #>> '{body,counts,bundled}', ''),
    NULLIF(v_async_response #>> '{body,bundle,counts,bundled}', '')
  );
  IF v_bundle_bundled_raw ~ '^\d+$' THEN
    v_bundle_bundled_count := v_bundle_bundled_raw::INT;
  END IF;

  IF jsonb_typeof(v_context #> '{label_print,bundle_async,request_payload,bundle,label_ids}') = 'array' THEN
    v_bundle_request_label_count := jsonb_array_length(v_context #> '{label_print,bundle_async,request_payload,bundle,label_ids}');
  ELSIF jsonb_typeof(v_metadata #> '{label_print,bundle_async,request_payload,bundle,label_ids}') = 'array' THEN
    v_bundle_request_label_count := jsonb_array_length(v_metadata #> '{label_print,bundle_async,request_payload,bundle,label_ids}');
  END IF;

  IF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' THEN
    IF v_pending_count > 0 OR v_fresh_ready_count < v_fresh_expected_count THEN
      v_output_url := NULL;
      v_output_source := NULL;
    ELSIF v_fresh_expected_count > 0 AND (
      (v_bundle_requested_count IS NOT NULL AND v_bundle_requested_count < v_fresh_expected_count)
      OR (v_bundle_bundled_count IS NOT NULL AND v_bundle_bundled_count < v_fresh_expected_count)
      OR (v_bundle_request_label_count IS NOT NULL AND v_bundle_request_label_count < v_fresh_expected_count)
    ) THEN
      v_output_url := NULL;
      v_output_source := NULL;
    END IF;
  END IF;

  SELECT COALESCE(
           NULLIF(wrs.operation_result #>> '{execute,timings,total_ms}', ''),
           NULLIF(wrs.operation_result #>> '{timings,total_ms}', ''),
           CASE
             WHEN wrs.duration_ms IS NOT NULL THEN wrs.duration_ms::text
             ELSE NULL
           END
         )
  INTO v_execute_duration_raw
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.handler_key = 'label_print_execute'
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;
  IF COALESCE(v_execute_duration_raw, '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_stage_execute_ms := v_execute_duration_raw::numeric;
  END IF;

  SELECT COALESCE(
           NULLIF(wrs.operation_result #>> '{duration_ms}', ''),
           CASE
             WHEN wrs.duration_ms IS NOT NULL THEN wrs.duration_ms::text
             ELSE NULL
           END
         )
  INTO v_prepare_duration_raw
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.handler_key = 'label_print_prepare'
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;
  IF COALESCE(v_prepare_duration_raw, '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_stage_prepare_ms := v_prepare_duration_raw::numeric;
  END IF;

  SELECT COALESCE(
           NULLIF(wrs.operation_result #>> '{bundle,timings,total_ms}', ''),
           NULLIF(wrs.operation_result #>> '{timings,total_ms}', ''),
           CASE
             WHEN wrs.duration_ms IS NOT NULL THEN wrs.duration_ms::text
             ELSE NULL
           END
         )
  INTO v_bundle_duration_raw
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.handler_key = 'label_bundle'
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;
  IF COALESCE(v_bundle_duration_raw, '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_stage_bundle_wait_ms := v_bundle_duration_raw::numeric;
  END IF;

  SELECT COALESCE(
           NULLIF(wrs.operation_result #>> '{duration_ms}', ''),
           CASE
             WHEN wrs.duration_ms IS NOT NULL THEN wrs.duration_ms::text
             ELSE NULL
           END
         )
  INTO v_finalize_duration_raw
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_workflow_run_id
    AND wrs.handler_key = 'label_print_finalize'
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;
  IF COALESCE(v_finalize_duration_raw, '') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_stage_finalize_ms := v_finalize_duration_raw::numeric;
  END IF;

  BEGIN
    v_stage_enqueue_ms := NULLIF(
      COALESCE(
        NULLIF(v_context #>> '{label_print,execute_response,timings,enqueue_ms}', ''),
        NULLIF(v_execute_result #>> '{timings,enqueue_ms}', ''),
        NULLIF(v_context #>> '{label_print,execute_response,steps,0,duration_ms}', ''),
        NULLIF(v_execute_result #>> '{steps,0,duration_ms}', ''),
        NULLIF(v_step_result #>> '{execute,timings,enqueue_ms}', ''),
        NULLIF(v_step_result #>> '{execute,steps,0,duration_ms}', ''),
        NULLIF(v_execute_async_body #>> '{timings,enqueue_ms}', ''),
        NULLIF(v_execute_async_body #>> '{steps,0,duration_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,timings,enqueue_ms}', '')
      ),
      ''
    )::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_stage_enqueue_ms := NULL;
  END;
  IF v_stage_enqueue_ms IS NULL THEN
    BEGIN
      SELECT NULLIF(step_elem->>'duration_ms', '')::numeric
      INTO v_stage_enqueue_ms
      FROM jsonb_array_elements(
        COALESCE(
          v_execute_result->'steps',
          v_step_result->'execute'->'steps',
          v_execute_async_body->'steps',
          v_execute_async_response #> '{body,steps}',
          '[]'::jsonb
        )
      ) AS step_elem
      WHERE step_elem->>'step' = 'enqueue_label_jobs'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_stage_enqueue_ms := NULL;
    END;
  END IF;
  BEGIN
    v_stage_render_ms := NULLIF(
      COALESCE(
        NULLIF(v_context #>> '{label_print,execute_response,timings,render_ms}', ''),
        NULLIF(v_context #>> '{label_print,execute_response,bundle,timings,render_ms}', ''),
        NULLIF(v_execute_result #>> '{timings,render_ms}', ''),
        NULLIF(v_execute_result #>> '{bundle,timings,render_ms}', ''),
        NULLIF(v_step_result #>> '{execute,timings,render_ms}', ''),
        NULLIF(v_step_result #>> '{execute,bundle,timings,render_ms}', ''),
        NULLIF(v_execute_async_body #>> '{timings,render_ms}', ''),
        NULLIF(v_execute_async_body #>> '{bundle,timings,render_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,timings,render_ms}', '')
      ),
      ''
    )::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_stage_render_ms := NULL;
  END;
  IF v_stage_render_ms IS NULL THEN
    BEGIN
      SELECT COALESCE(
        NULLIF(step_elem->>'duration_ms', '')::numeric,
        NULLIF(step_elem #>> '{calls,0,render_ms}', '')::numeric
      )
      INTO v_stage_render_ms
      FROM jsonb_array_elements(
        COALESCE(
          v_execute_result->'steps',
          v_step_result->'execute'->'steps',
          v_execute_async_body->'steps',
          v_execute_async_response #> '{body,steps}',
          '[]'::jsonb
        )
      ) AS step_elem
      WHERE step_elem->>'step' = 'render_label_jobs'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_stage_render_ms := NULL;
    END;
  END IF;
  BEGIN
    v_stage_bundle_ms := NULLIF(
      COALESCE(
        NULLIF(v_context #>> '{label_print,execute_response,timings,bundle_ms}', ''),
        NULLIF(v_context #>> '{label_print,execute_response,bundle,timings,total_ms}', ''),
        NULLIF(v_execute_result #>> '{timings,bundle_ms}', ''),
        NULLIF(v_execute_result #>> '{bundle,timings,total_ms}', ''),
        NULLIF(v_step_result #>> '{execute,timings,bundle_ms}', ''),
        NULLIF(v_step_result #>> '{execute,bundle,timings,total_ms}', ''),
        NULLIF(v_execute_async_body #>> '{timings,bundle_ms}', ''),
        NULLIF(v_execute_async_body #>> '{bundle,timings,total_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,timings,bundle_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,bundle,timings,total_ms}', '')
      ),
      ''
    )::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_stage_bundle_ms := NULL;
  END;
  BEGIN
    v_stage_complete_ms := NULLIF(
      COALESCE(
        NULLIF(v_context #>> '{label_print,execute_response,timings,complete_ms}', ''),
        NULLIF(v_execute_result #>> '{timings,complete_ms}', ''),
        NULLIF(v_step_result #>> '{execute,timings,complete_ms}', ''),
        NULLIF(v_execute_async_body #>> '{timings,complete_ms}', ''),
        NULLIF(v_execute_async_response #>> '{body,timings,complete_ms}', '')
      ),
      ''
    )::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_stage_complete_ms := NULL;
  END;

  v_print_mode := COALESCE(
    NULLIF(v_context #>> '{label_print,print_mode}', ''),
    NULLIF(v_execute_result->>'mode', ''),
    NULLIF(v_step_result->>'print_mode', ''),
    NULLIF(v_step_result #>> '{execute,mode}', ''),
    NULLIF(v_execute_async_body->>'mode', ''),
    'print_sync'
  );
  v_artifact_kind := COALESCE(
    NULLIF(v_context #>> '{label_print,artifact_kind}', ''),
    NULLIF(v_execute_result->>'artifact_kind', ''),
    NULLIF(v_execute_result #>> '{bundle,artifact_kind}', ''),
    NULLIF(v_step_result->>'artifact_kind', ''),
    NULLIF(v_step_result #>> '{execute,artifact_kind}', ''),
    NULLIF(v_step_result #>> '{execute,bundle,artifact_kind}', ''),
    NULLIF(v_execute_async_body->>'artifact_kind', ''),
    NULLIF(v_execute_async_body #>> '{bundle,artifact_kind}', ''),
    NULLIF(v_bundle_response->>'artifact_kind', '')
  );

  IF COALESCE(v_fresh_state->>'render_wait_ms', '') ~ '^\d+$' THEN
    v_stage_render_wait_ms := (v_fresh_state->>'render_wait_ms')::numeric;
  END IF;
  IF v_stage_render_wait_ms IS NULL THEN
    v_stage_render_wait_ms := v_stage_render_ms;
  END IF;
  IF v_stage_bundle_wait_ms IS NULL THEN
    v_stage_bundle_wait_ms := COALESCE(v_stage_bundle_ms, v_stage_execute_ms);
  END IF;
  IF v_stage_complete_ms IS NULL THEN
    v_stage_complete_ms := v_stage_finalize_ms;
  END IF;

  v_terminal := COALESCE(v_run.workflow_status, '') IN ('completed', 'failed', 'cancelled');
  IF v_output_url IS NULL
     AND v_output_file_path IS NULL
     AND v_terminal
     AND (
       (v_execute_request_id IS NOT NULL AND NOT v_execute_async_completed)
       OR (v_async_request_id IS NOT NULL AND NOT v_async_completed)
     ) THEN
    v_terminal := FALSE;
  END IF;

  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_phase := 'failed';
  ELSIF v_output_url IS NOT NULL THEN
    v_phase := 'downloading';
  ELSIF v_output_file_path IS NOT NULL THEN
    v_phase := 'downloading';
  ELSIF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' AND v_pending_count > 0 THEN
    v_phase := 'generating';
  ELSIF v_execute_request_id IS NOT NULL AND NOT v_execute_async_completed THEN
    v_phase := 'generating';
  ELSIF v_async_request_id IS NOT NULL AND NOT v_async_completed THEN
    v_phase := 'bundling';
  ELSIF COALESCE(v_run.current_operation, '') IN ('label_print_prepare', 'execute_label_print') THEN
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
  ELSIF v_fresh_generation_required AND v_fresh_failed_count > 0 THEN
    v_failure_reason := 'label_jobs_failed';
  ELSIF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only'
        AND v_fresh_expected_count > 0
        AND (
          (v_bundle_requested_count IS NOT NULL AND v_bundle_requested_count < v_fresh_expected_count)
          OR (v_bundle_bundled_count IS NOT NULL AND v_bundle_bundled_count < v_fresh_expected_count)
          OR (v_bundle_request_label_count IS NOT NULL AND v_bundle_request_label_count < v_fresh_expected_count)
        ) THEN
    v_failure_reason := 'incomplete_fresh_bundle_response';
  END IF;

  IF v_output_url IS NULL THEN
    FOREACH v_path IN ARRAY v_file_path_paths LOOP
      v_path := btrim(COALESCE(v_path, ''));
      IF v_path = '' THEN
        CONTINUE;
      END IF;

      v_segments := string_to_array(regexp_replace(v_path, '\\[(\\d+)\\]', '.\\1', 'g'), '.');
      IF v_segments IS NULL OR array_length(v_segments, 1) IS NULL THEN
        CONTINUE;
      END IF;

      v_value := NULLIF(btrim(v_detail #>> v_segments), '');
      IF v_value IS NOT NULL AND v_value !~* '^https?://' THEN
        v_output_file_path := v_value;
        IF v_path LIKE 'context.%' THEN
          v_output_source := 'context';
        ELSIF v_path LIKE 'metadata.%' THEN
          v_output_source := 'metadata';
        ELSIF v_path LIKE 'execute_result.%' THEN
          v_output_source := 'execute_result';
        ELSIF v_path LIKE 'step_result.%' THEN
          v_output_source := 'step_result';
        ELSIF v_path LIKE 'execute_async_body.%' OR v_path LIKE 'execute_async_response.%' THEN
          v_output_source := 'execute_async_response';
        ELSIF v_path LIKE 'async_body.%' OR v_path LIKE 'async_response.%' THEN
          v_output_source := 'async_response';
        ELSE
          v_output_source := 'file_path';
        END IF;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_output_url IS NULL
     AND v_output_file_path IS NULL
     AND v_fresh_generation_required
     AND v_fresh_resolve_mode = 'workflow_scope_only'
     AND v_fresh_expected_count = 1
     AND v_fresh_ready_count = 1 THEN
    v_output_file_path := NULLIF(v_fresh_state #>> '{ready,0,file_url}', '');
    IF v_output_file_path ~* '^https?://' THEN
      v_output_url := v_output_file_path;
      v_output_file_path := NULL;
      v_output_source := 'fresh_ready_url';
    ELSIF v_output_file_path IS NOT NULL THEN
      v_output_source := 'fresh_ready_file';
      v_output_needs_signing := TRUE;
    END IF;
  END IF;

  IF v_output_file_path IS NOT NULL THEN
    v_output_needs_signing := TRUE;
    IF v_phase <> 'failed' THEN
      v_phase := 'downloading';
    END IF;
  END IF;

  IF COALESCE(v_run.workflow_status, '') = 'completed' AND v_output_url IS NULL AND v_output_file_path IS NULL THEN
    IF (v_execute_request_id IS NOT NULL AND NOT v_execute_async_completed)
       OR (v_async_request_id IS NOT NULL AND NOT v_async_completed) THEN
      v_failure_reason := NULL;
    ELSIF NULLIF(v_execute_async_body->>'error', '') IS NOT NULL THEN
      v_failure_reason := format('print_async_error: %s', v_execute_async_body->>'error');
    ELSIF NULLIF(v_async_body->>'error', '') IS NOT NULL THEN
      v_failure_reason := format('bundle_async_error: %s', v_async_body->>'error');
    ELSE
      v_failure_reason := 'workflow completed without output URL';
    END IF;
  END IF;

  v_function_total_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,execute_response,timings,total_ms}', ''),
    NULLIF(v_execute_result #>> '{timings,total_ms}', ''),
    NULLIF(v_step_result #>> '{execute,timings,total_ms}', ''),
    NULLIF(v_step_result #>> '{timings,total_ms}', ''),
    NULLIF(v_step_result #>> '{bundle,timings,total_ms}', ''),
    NULLIF(v_execute_async_body #>> '{timings,total_ms}', ''),
    NULLIF(v_execute_async_body #>> '{bundle,timings,total_ms}', ''),
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
  IF v_function_total_ms IS NULL THEN
    v_function_total_ms := COALESCE(v_stage_execute_ms, v_stage_bundle_ms, v_stage_bundle_wait_ms);
  END IF;

  v_ready_source := v_output_source;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', v_run.id,
    'workflow_status', v_run.workflow_status,
    'current_operation', v_run.current_operation,
    'phase', v_phase,
    'output_url', v_output_url,
    'output_file_path', v_output_file_path,
    'output_bucket', v_output_bucket,
    'output_needs_signing', v_output_needs_signing,
    'output_source', v_output_source,
    'ready_source', v_ready_source,
    'output_ready', v_output_url IS NOT NULL OR v_output_file_path IS NOT NULL,
    'terminal', v_terminal,
    'failure_reason', v_failure_reason,
    'pending_count', v_pending_count,
    'ready_count', v_ready_count,
    'fresh_expected_count', v_fresh_expected_count,
    'fresh_ready_count', v_fresh_ready_count,
    'fresh_failed_count', v_fresh_failed_count,
    'fresh_bundle_requested_count', v_bundle_requested_count,
    'fresh_bundle_bundled_count', v_bundle_bundled_count,
    'fresh_bundle_request_label_count', v_bundle_request_label_count,
    'fresh_request_scope_key', CASE WHEN v_fresh_scope_step_id IS NOT NULL THEN v_fresh_scope_step_id::text ELSE NULL END,
    'fresh_only_resolved', v_fresh_only_resolved,
    'print_async_request_id', v_execute_request_id,
    'print_async_completed', v_execute_async_completed,
    'print_mode', v_print_mode,
    'artifact_kind', v_artifact_kind,
    'bundle_async_request_id', v_async_request_id,
    'bundle_async_completed', v_async_completed,
    'function_total_ms', v_function_total_ms,
    'stage_prepare_ms', v_stage_prepare_ms,
    'stage_execute_ms', v_stage_execute_ms,
    'stage_enqueue_ms', v_stage_enqueue_ms,
    'stage_render_ms', v_stage_render_ms,
    'stage_bundle_ms', v_stage_bundle_ms,
    'stage_complete_ms', v_stage_complete_ms,
    'stage_render_wait_ms', v_stage_render_wait_ms,
    'stage_bundle_wait_ms', v_stage_bundle_wait_ms,
    'stage_finalize_ms', v_stage_finalize_ms,
    'status_checked_at', v_status_checked_at,
    'poll_progress_managed', CASE WHEN v_poll_progress_managed THEN TRUE ELSE NULL END,
    'poll_progress_attempted', CASE WHEN v_poll_progress_attempted THEN TRUE ELSE NULL END,
    'poll_progress_status', v_poll_progress_status,
    'poll_progress_error', v_poll_progress_error,
    'print_async_progress_attempted', CASE WHEN v_execute_progress_attempted THEN TRUE ELSE NULL END,
    'print_async_progress_status', v_execute_progress_status,
    'print_async_progress_error', v_execute_progress_error,
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

REVOKE ALL ON FUNCTION public.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) TO authenticated, service_role;


SELECT pg_advisory_unlock(hashtext('202603063240_ui_get_workflow_run_output_status_execute_result_fallback_v1'));
COMMIT;
