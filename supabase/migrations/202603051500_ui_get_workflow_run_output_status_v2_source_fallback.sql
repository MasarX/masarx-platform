-- Migration: Extend ui_get_workflow_run_output_status_v1 with output-source metadata and step-result fallback
BEGIN;
SELECT pg_advisory_lock(hashtext('202603051500_ui_get_workflow_run_output_status_v2_source_fallback'));
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
  v_output_source TEXT := NULL;
  v_paths TEXT[] := COALESCE(
    p_output_url_paths,
    ARRAY[
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
      'step_result.bundle.file_url'
    ]::TEXT[]
  );
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

  v_detail := jsonb_build_object(
    'context', v_context,
    'metadata', v_metadata,
    'step_result', COALESCE(v_step_result, '{}'::jsonb)
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

  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_phase := 'failed';
  ELSIF v_output_url IS NOT NULL THEN
    v_phase := 'downloading';
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
    v_failure_reason := 'workflow completed without output URL';
  END IF;

  RETURN jsonb_build_object(
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

SELECT pg_advisory_unlock(hashtext('202603051500_ui_get_workflow_run_output_status_v2_source_fallback'));
COMMIT;
