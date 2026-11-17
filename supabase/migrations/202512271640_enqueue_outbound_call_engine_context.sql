-- Migration: Enforce workflow engine context for outbound enqueue helper
-- Purpose: Ensure enqueue_outbound_call_from_operation_template_v1 always runs with workflow context.

BEGIN;

CREATE OR REPLACE FUNCTION public.enqueue_outbound_call_from_operation_template_v1(
  p_operation_template_id UUID,
  p_payload JSONB,
  p_job_context JSONB,
  p_correlation_id UUID,
  p_priority INT DEFAULT 90,
  p_max_retries INT DEFAULT 3,
  p_override_url TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_operation operation_templates%ROWTYPE;
  v_auth provider_auth_configs%ROWTYPE;
  v_mapping_scope JSONB;
  v_headers JSONB;
  v_body JSONB;
  v_call_type TEXT;
  v_target_url TEXT;
  v_outbound_id UUID;
  v_step TEXT;
  v_step_id UUID;
  v_run_id UUID;
  v_template_id UUID;
  v_template_version INT;
  v_template_step workflow_template_steps%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_policy_ctx JSONB;
  v_defaults JSONB;
  v_wrapper_template_id UUID;
  v_org_id UUID;
  v_created_wrapper BOOLEAN := FALSE;
BEGIN
  IF p_operation_template_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: operation_template_id is required';
  END IF;

  SELECT *
  INTO v_operation
  FROM public.operation_templates
  WHERE id = p_operation_template_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: operation_template % not found', p_operation_template_id;
  END IF;

  SELECT *
  INTO v_auth
  FROM public.provider_auth_configs pac
  WHERE pac.provider_id = v_operation.provider_id
  ORDER BY pac.created_at DESC
  LIMIT 1;

  v_mapping_scope := jsonb_strip_nulls(jsonb_build_object(
    'context', COALESCE(p_job_context, '{}'::jsonb),
    'payload', COALESCE(p_payload, '{}'::jsonb),
    'operation', jsonb_build_object('id', v_operation.id, 'name', v_operation.operation_name),
    'provider_auth', CASE WHEN v_auth.id IS NOT NULL THEN jsonb_build_object('auth_type', v_auth.auth_type, 'credentials', v_auth.credentials) ELSE NULL END
  ));

  v_headers := apply_request_mappings(
    COALESCE(v_operation.headers_template, '{}'::jsonb),
    COALESCE(v_operation.request_mappings->'headers', '{}'::jsonb),
    v_mapping_scope
  );

  v_body := apply_request_mappings(
    COALESCE(v_operation.body_template, '{}'::jsonb),
    COALESCE(v_operation.request_mappings->'body', '{}'::jsonb),
    v_mapping_scope
  );

  v_call_type := COALESCE(NULLIF(v_operation.call_type, ''), 'provider_api');
  IF v_call_type NOT IN ('provider_api', 'client_webhook', 'comms_sms', 'comms_whatsapp', 'comms_email', 'comms_voice') THEN
    RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: unsupported call_type % for operation %', v_call_type, v_operation.id;
  END IF;

  v_target_url := COALESCE(NULLIF(p_override_url, ''), v_operation.url_template);
  IF v_target_url IS NULL OR btrim(v_target_url) = '' THEN
    RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: url_template missing for operation %', v_operation.id;
  END IF;

  v_step := current_setting('app.workflow_run_step_id', TRUE);

  IF v_step IS NULL OR btrim(v_step) = '' THEN
    SELECT organization_id
    INTO v_org_id
    FROM public.providers
    WHERE id = v_operation.provider_id;

    v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
      'organization_id', COALESCE(p_job_context->>'organization_id', v_org_id::text),
      'client_id', p_job_context->>'client_id',
      'sender_id', p_job_context->>'sender_id',
      'webhook_source_id', p_job_context->>'webhook_source_id'
    ));

    SELECT value
    INTO v_defaults
    FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
    LIMIT 1;

    BEGIN
      v_wrapper_template_id := NULLIF(v_defaults->>'legacy_outbound_template_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_wrapper_template_id := NULL;
    END;

    IF v_wrapper_template_id IS NULL THEN
      RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: legacy workflow template missing';
    END IF;

    SELECT id, version
    INTO v_template_id, v_template_version
    FROM public.workflow_templates
    WHERE id = v_wrapper_template_id
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1;

    IF v_template_id IS NULL THEN
      RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: legacy workflow template missing';
    END IF;

    SELECT *
    INTO v_template_step
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND enabled = TRUE
    ORDER BY sequence_order, updated_at DESC
    LIMIT 1;

    IF v_template_step.id IS NULL THEN
      RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: legacy workflow step missing';
    END IF;

    v_run_id := gen_random_uuid();
    v_step_id := gen_random_uuid();
    v_created_wrapper := TRUE;

    PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
    PERFORM set_config('app.workflow_run_step_id', v_step_id::text, true);

    INSERT INTO public.workflow_runs (
      id,
      workflow_template_id,
      workflow_template_version,
      entry_point,
      workflow_status,
      current_step_id,
      context,
      metadata,
      created_at,
      started_at,
      updated_at,
      completed_at
    )
    VALUES (
      v_run_id,
      v_template_id,
      COALESCE(v_template_version, 1),
      'enqueue_outbound_call',
      'completed',
      NULL,
      jsonb_strip_nulls(jsonb_build_object(
        'source', 'enqueue_outbound_call_from_operation_template_v1',
        'operation_template_id', v_operation.id,
        'operation_name', v_operation.operation_name,
        'call_type', v_call_type,
        'payload', COALESCE(p_payload, '{}'::jsonb),
        'job_context', COALESCE(p_job_context, '{}'::jsonb)
      )),
      jsonb_build_object('source', 'enqueue_outbound_call_from_operation_template_v1'),
      v_now,
      v_now,
      v_now,
      v_now
    );

    INSERT INTO public.workflow_run_steps (
      id,
      workflow_run_id,
      workflow_template_step_id,
      sequence_order,
      step_status,
      operation_name,
      max_retries,
      metadata,
      handler_key,
      handler_version,
      operation_started_at,
      operation_completed_at,
      duration_ms,
      retry_attempt,
      enqueued_at,
      created_at,
      updated_at
    )
    VALUES (
      v_step_id,
      v_run_id,
      v_template_step.id,
      COALESCE(v_template_step.sequence_order, 1),
      'completed',
      v_template_step.operation_name,
      GREATEST(COALESCE(p_max_retries, 3), 1),
      jsonb_strip_nulls(COALESCE(v_template_step.metadata, '{}'::jsonb) || jsonb_build_object(
        'operation_template_id', v_operation.id,
        'operation_name', v_operation.operation_name
      )),
      v_template_step.handler_key,
      COALESCE(NULLIF(v_template_step.handler_version, ''), 'v1'),
      v_now,
      v_now,
      0,
      0,
      v_now,
      v_now,
      v_now
    );

    PERFORM set_config('masarx.workflow_engine', '1', true);
    PERFORM set_config('masarx.workflow_run_step_id', v_step_id::text, true);
  ELSE
    BEGIN
      v_step_id := NULLIF(v_step, '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_step_id := NULL;
    END;
  END IF;

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    priority,
    max_retries,
    context,
    correlation_id,
    workflow_run_step_id
  )
  VALUES (
    v_call_type,
    'provider',
    v_operation.provider_id,
    v_operation.method,
    v_target_url,
    v_headers,
    v_body,
    COALESCE(p_priority, 90),
    GREATEST(COALESCE(p_max_retries, 3), 1),
    jsonb_strip_nulls(COALESCE(p_job_context, '{}'::jsonb) || jsonb_build_object(
      'operation_template_id', v_operation.id,
      'operation_name', v_operation.operation_name
    )),
    p_correlation_id,
    v_step_id
  )
  RETURNING id INTO v_outbound_id;

  IF v_created_wrapper THEN
    UPDATE public.workflow_run_steps
    SET operation_result = jsonb_build_object('outbound_call_id', v_outbound_id),
        updated_at = now()
    WHERE id = v_step_id;
  END IF;

  RETURN v_outbound_id;
END;
$$;

COMMIT;
