-- Migration: ui_get_workflow_run_output_status_v1 file-path fast path
-- Purpose:
--  - Expose trusted workflow output file paths when the artifact exists but still needs signing.
--  - Keep fresh-only completeness guards while enabling a single-file fast path before signed URL materialization.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061840_ui_get_workflow_run_output_status_v9_file_path_fast_path'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_get_workflow_run_output_status_v1(
  p_workflow_run_id UUID,
  p_output_url_paths TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
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
      'step_result.bundle.output_file_url',
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
      'context.label_print.bundle_response.signed_url',
      'context.label_print.bundle_response.file_url',
      'metadata.label_print.bundle_response.signed_url',
      'metadata.label_print.bundle_response.file_url',
      'step_result.signed_url',
      'step_result.output_url',
      'step_result.file_url',
      'step_result.bundle.signed_url',
      'step_result.bundle.output_url',
      'step_result.bundle.file_url',
      'step_result.bundle.output_file_url',
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
      'context.label_print.bundle_response.file_path',
      'metadata.label_print.bundle_response.file_path',
      'step_result.file_path',
      'step_result.bundle.file_path',
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
  v_status_checked_at TIMESTAMPTZ := now();
  v_function_total_raw TEXT := '';
  v_function_total_ms NUMERIC := NULL;
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
  v_stage_render_wait_ms NUMERIC := NULL;
  v_stage_bundle_wait_ms NUMERIC := NULL;
  v_stage_finalize_ms NUMERIC := NULL;
  v_ready_source TEXT := NULL;
  v_prepare_duration_raw TEXT := '';
  v_bundle_duration_raw TEXT := '';
  v_finalize_duration_raw TEXT := '';
  v_bundle_requested_raw TEXT := '';
  v_bundle_requested_count INT := NULL;
  v_bundle_bundled_raw TEXT := '';
  v_bundle_bundled_count INT := NULL;
  v_bundle_request_label_count INT := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 requires authenticated user';
  END IF;
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 requires workflow_run_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.read', v_scope_type, v_scope_id);

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
  END IF;

  IF NOT public.is_platform_user() THEN
    IF v_org_id IS NULL OR v_run_org_id IS NULL OR v_run_org_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'ui_get_workflow_run_output_status_v1 access denied for workflow_run %', p_workflow_run_id;
    END IF;
  END IF;

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

  v_async_request_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,bundle_async,request_id}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_async,request_id}', '')
  );
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

  v_detail := jsonb_build_object(
    'context', v_context,
    'metadata', v_metadata,
    'step_result', COALESCE(v_step_result, '{}'::jsonb),
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

  v_bundle_requested_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,bundle_response,counts,requested}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_response,counts,requested}', ''),
    NULLIF(v_step_result #>> '{counts,requested}', ''),
    NULLIF(v_step_result #>> '{bundle,counts,requested}', ''),
    NULLIF(v_async_body #>> '{counts,requested}', ''),
    NULLIF(v_async_body #>> '{bundle,counts,requested}', ''),
    NULLIF(v_async_response #>> '{body,counts,requested}', ''),
    NULLIF(v_async_response #>> '{body,bundle,counts,requested}', '')
  );
  IF v_bundle_requested_raw ~ '^\d+$' THEN
    v_bundle_requested_count := v_bundle_requested_raw::INT;
  END IF;

  v_bundle_bundled_raw := COALESCE(
    NULLIF(v_context #>> '{label_print,bundle_response,counts,bundled}', ''),
    NULLIF(v_metadata #>> '{label_print,bundle_response,counts,bundled}', ''),
    NULLIF(v_step_result #>> '{counts,bundled}', ''),
    NULLIF(v_step_result #>> '{bundle,counts,bundled}', ''),
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

  IF COALESCE(v_fresh_state->>'render_wait_ms', '') ~ '^\d+$' THEN
    v_stage_render_wait_ms := (v_fresh_state->>'render_wait_ms')::numeric;
  END IF;

  v_terminal := COALESCE(v_run.workflow_status, '') IN ('completed', 'failed', 'cancelled');
  IF v_output_url IS NULL AND v_terminal AND v_async_request_id IS NOT NULL AND NOT v_async_completed THEN
    v_terminal := FALSE;
  END IF;

  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_phase := 'failed';
  ELSIF v_output_url IS NOT NULL THEN
    v_phase := 'downloading';
  ELSIF v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only' AND v_pending_count > 0 THEN
    v_phase := 'generating';
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
        ELSIF v_path LIKE 'step_result.%' THEN
          v_output_source := 'step_result';
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

  v_ready_source := v_output_source;

  RETURN jsonb_build_object(
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
    'bundle_async_request_id', v_async_request_id,
    'bundle_async_completed', v_async_completed,
    'function_total_ms', v_function_total_ms,
    'stage_prepare_ms', v_stage_prepare_ms,
    'stage_render_wait_ms', v_stage_render_wait_ms,
    'stage_bundle_wait_ms', v_stage_bundle_wait_ms,
    'stage_finalize_ms', v_stage_finalize_ms,
    'status_checked_at', v_status_checked_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION api.ui_get_workflow_run_output_status_v1(
  p_workflow_run_id UUID,
  p_output_url_paths TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_get_workflow_run_output_status_v1(p_workflow_run_id, p_output_url_paths);
$$;

SELECT pg_advisory_unlock(hashtext('202603061840_ui_get_workflow_run_output_status_v9_file_path_fast_path'));
COMMIT;
