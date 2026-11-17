-- Migration: Workflow handler defaults via workflow_defaults
-- Purpose: Remove hardcoded fallback defaults in core handlers.

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_outbound_http_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_operation public.operation_templates%ROWTYPE;
    v_payload JSONB;
    v_provider_defaults JSONB := '{}'::jsonb;
    v_mapping_scope JSONB;
    v_headers JSONB;
    v_body JSONB;
    v_call_type TEXT;
    v_target_url TEXT;
    v_outbound_id UUID;
    v_priority INT;
    v_response public.workflow_handler_response;
    v_context JSONB;
    v_defaults JSONB;
    v_policy_ctx JSONB;
    v_default_priority INT;

    v_org_id UUID := NULL;
    v_client_id UUID := NULL;
    v_shipment_id UUID := NULL;
    v_recipient_phone TEXT := NULL;
    v_recipient_id UUID := NULL;
BEGIN
    IF NOT (p_step.metadata ? 'operation_template_id') THEN
        RAISE EXCEPTION 'execute_outbound_http_v1: metadata missing operation_template_id for step %', p_step.id;
    END IF;

    SELECT *
      INTO v_operation
      FROM public.operation_templates
     WHERE id = (p_step.metadata->>'operation_template_id')::UUID;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_outbound_http_v1: operation template % not found for step %',
            p_step.metadata->>'operation_template_id',
            p_step.id;
    END IF;

    v_payload := public.safe_jsonpath_query_first(
        jsonb_build_object(
            'context', COALESCE(p_run.context, '{}'::jsonb),
            'transformed_payload', COALESCE(p_run.context->'transformed_payload', '{}'::jsonb)
        ),
        COALESCE(p_step.metadata->>'payload_path', '$.transformed_payload')
    );

    IF v_payload IS NULL THEN
        v_payload := COALESCE(p_run.context->'transformed_payload', '{}'::jsonb);
    END IF;

    IF COALESCE((p_step.metadata->>'expects_provider_defaults')::BOOLEAN, FALSE) THEN
        SELECT cached_value
          INTO v_provider_defaults
          FROM public.settings
         WHERE category = 'provider_defaults'
           AND scope_type = 'resource'
           AND scope_id = v_operation.provider_id
         ORDER BY last_updated DESC
         LIMIT 1;

        v_provider_defaults := COALESCE(v_provider_defaults, '{}'::jsonb);
    END IF;

    v_mapping_scope := jsonb_build_object(
        'context', COALESCE(p_run.context, '{}'::jsonb),
        'transformed_payload', COALESCE(p_run.context->'transformed_payload', '{}'::jsonb),
        'payload', COALESCE(v_payload, '{}'::jsonb),
        'provider_defaults', v_provider_defaults,
        'step', p_step.metadata,
        'operation', jsonb_build_object(
            'id', v_operation.id,
            'name', v_operation.operation_name
        )
    );

    v_headers := public.apply_request_mappings(
        COALESCE(v_operation.headers_template, '{}'::jsonb),
        COALESCE(v_operation.request_mappings->'headers', '{}'::jsonb),
        v_mapping_scope
    );

    v_body := public.apply_request_mappings(
        COALESCE(v_operation.body_template, '{}'::jsonb),
        COALESCE(v_operation.request_mappings->'body', '{}'::jsonb),
        v_mapping_scope
    );

    v_call_type := COALESCE(
        NULLIF(p_step.metadata->>'call_type', ''),
        NULLIF(v_operation.call_type, ''),
        'provider_api'
    );

    IF v_call_type NOT IN ('provider_api', 'client_webhook', 'comms_sms', 'comms_whatsapp', 'comms_email', 'comms_voice') THEN
        RAISE EXCEPTION 'execute_outbound_http_v1: unsupported call_type % for operation %', v_call_type, v_operation.id;
    END IF;

    v_target_url := COALESCE(NULLIF(p_step.metadata->>'override_url', ''), v_operation.url_template);

    v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', COALESCE(p_run.context->>'organization_id', NULL),
        'client_id', COALESCE(p_run.context->>'client_id', NULL),
        'sender_id', COALESCE(p_run.context->>'sender_id', NULL),
        'webhook_source_id', COALESCE(p_run.context->>'webhook_source_id', NULL)
    ));

    SELECT value
      INTO v_defaults
      FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
     LIMIT 1;

    IF v_defaults IS NULL THEN
        v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
    END IF;

    BEGIN
      v_default_priority := NULLIF(v_defaults->>'default_priority', '')::INT;
    EXCEPTION
      WHEN others THEN
        v_default_priority := NULL;
    END;

    IF v_default_priority IS NULL THEN
        RAISE EXCEPTION 'execute_outbound_http_v1: workflow_defaults.default_priority missing';
    END IF;

    v_priority := COALESCE(
        NULLIF(p_step.metadata->>'priority', '')::INT,
        v_default_priority
    );

    -- Best-effort context enrichment for comms enforcement (opt-out/compliance).
    BEGIN
      v_org_id := NULLIF(p_run.context->>'organization_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_org_id := NULL;
    END;
    BEGIN
      v_client_id := NULLIF(p_run.context->>'client_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_client_id := NULL;
    END;
    BEGIN
      v_shipment_id := NULLIF(p_run.context->>'shipment_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_shipment_id := NULL;
    END;
    IF v_shipment_id IS NULL THEN
      BEGIN
        v_shipment_id := NULLIF(p_run.context->>'planned_shipment_id', '')::UUID;
      EXCEPTION
        WHEN others THEN
          v_shipment_id := NULL;
      END;
    END IF;

    IF v_call_type = 'comms_whatsapp' THEN
      v_recipient_phone := NULLIF(v_body->>'to', '');
      IF v_client_id IS NOT NULL AND v_recipient_phone IS NOT NULL THEN
        SELECT id
          INTO v_recipient_id
          FROM public.recipients
         WHERE client_id = v_client_id
           AND phone_number_normalized = public.normalize_phone_number(v_recipient_phone)
         ORDER BY created_at DESC
         LIMIT 1;
      END IF;
    END IF;

    v_context := jsonb_build_object(
        'workflow_run_id', p_step.workflow_run_id,
        'workflow_run_step_id', p_step.id,
        'operation_template_id', v_operation.id,
        'operation_name', p_step.operation_name
    );

    IF v_call_type = 'comms_whatsapp' THEN
      v_context := jsonb_strip_nulls(v_context || jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'recipient_id', v_recipient_id
      ));
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
        correlation_id,
        shipment_id,
        context,
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
        v_priority,
        p_step.max_retries,
        CASE
            WHEN p_run.context ? 'correlation_id' THEN (p_run.context->>'correlation_id')::UUID
            ELSE NULL
        END,
        v_shipment_id,
        v_context,
        p_step.id
    )
    RETURNING id INTO v_outbound_id;

    UPDATE public.workflow_run_steps
       SET operation_result = jsonb_build_object(
              'outbound_call_id', v_outbound_id,
              'headers', v_headers,
              'body', v_body
          ),
          updated_at = now()
     WHERE id = p_step.id;

    v_response.status := 'in_progress';
    v_response.operation_result := jsonb_build_object(
        'outbound_call_id', v_outbound_id,
        'headers', v_headers,
        'body', v_body
    );

    -- Strict engine flow: provide the job id to following steps (no fallbacks)
    v_response.context_patch := jsonb_build_object('last_outbound_call_id', v_outbound_id);

    RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_job_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_action TEXT := COALESCE(NULLIF(v_metadata->>'action', ''), CASE
        WHEN p_step.operation_name = 'wait_for_label_job' THEN 'wait'
        ELSE 'enqueue'
    END);
    v_label_type TEXT;
    v_shipment_id UUID;
    v_shipment_box_id UUID;
    v_label_job_id UUID;
    v_label_record label_jobs%ROWTYPE;
    v_poll_seconds INT;
    v_max_wait_seconds INT;
    v_total_wait INT;
    v_now TIMESTAMPTZ := now();
    v_context JSONB;
    v_response public.workflow_handler_response;
    v_label_jobs JSONB;
    v_defaults JSONB;
    v_policy_ctx JSONB;
    v_default_poll INT;
    v_default_max_wait INT;
BEGIN
    IF v_action = 'enqueue' THEN
        v_label_type := COALESCE(NULLIF(v_metadata->>'label_type', ''), 'shipping');

        v_shipment_id := COALESCE(
            NULLIF(p_run.context->>'shipment_id', '')::UUID,
            NULLIF(p_run.context->'transformed_payload'->>'shipment_id', '')::UUID,
            NULLIF(p_run.context->'transformed_payload'->'shipment'->>'id', '')::UUID,
            NULLIF(p_run.context->'shipment'->>'id', '')::UUID
        );

        v_shipment_box_id := COALESCE(
            NULLIF(p_run.context->>'shipment_box_id', '')::UUID,
            NULLIF(p_run.context->'transformed_payload'->>'shipment_box_id', '')::UUID,
            NULLIF(p_run.context->'transformed_payload'->'box'->>'id', '')::UUID,
            NULLIF(p_run.context->'shipment_box'->>'id', '')::UUID
        );

        IF v_shipment_id IS NULL THEN
            RAISE EXCEPTION 'execute_label_job_v1: shipment_id not available in workflow context for run %', p_step.workflow_run_id;
        END IF;

        v_label_job_id := request_label_generation(
            v_shipment_id,
            v_label_type,
            NULL,
            COALESCE(NULLIF(v_metadata->>'requested_source', ''), 'workflow'),
            v_shipment_box_id,
            COALESCE(NULLIF(v_metadata->>'job_purpose', ''), 'primary')
        );

        v_label_jobs := COALESCE(p_run.context->'label_jobs', '[]'::jsonb)
            || jsonb_build_object(
                'label_job_id', v_label_job_id,
                'label_type', v_label_type,
                'workflow_step_id', p_step.workflow_template_step_id,
                'created_at', v_now
            );

        v_context := jsonb_set(
            COALESCE(p_run.context, '{}'::jsonb),
            '{label_jobs}',
            v_label_jobs,
            TRUE
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'status', 'queued',
            'label_job_id', v_label_job_id,
            'label_type', v_label_type,
            'shipment_id', v_shipment_id,
            'shipment_box_id', v_shipment_box_id
        );
        v_response.context_patch := v_context;

        RETURN v_response;
    END IF;

    IF v_action <> 'wait' THEN
        RAISE EXCEPTION 'execute_label_job_v1: unsupported action %', v_action;
    END IF;

    SELECT (operation_result->>'label_job_id')::UUID
    INTO v_label_job_id
    FROM workflow_run_steps
    WHERE workflow_run_id = p_step.workflow_run_id
      AND sequence_order < p_step.sequence_order
      AND operation_name = 'generate_label_job'
    ORDER BY sequence_order DESC
    LIMIT 1;

    IF v_label_job_id IS NULL THEN
        v_label_job_id := NULLIF(v_metadata->>'label_job_id', '')::UUID;
    END IF;

    IF v_label_job_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_job_v1: label_job_id not found for run %', p_step.workflow_run_id;
    END IF;

    SELECT *
    INTO v_label_record
    FROM label_jobs
    WHERE id = v_label_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_label_job_v1: label job % missing for workflow run %', v_label_job_id, p_step.workflow_run_id;
    END IF;

    v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_label_record.organization_id,
        'client_id', v_label_record.client_id,
        'sender_id', COALESCE(p_run.context->>'sender_id', NULL),
        'webhook_source_id', COALESCE(p_run.context->>'webhook_source_id', NULL)
    ));

    SELECT value
      INTO v_defaults
      FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
     LIMIT 1;

    IF v_defaults IS NULL THEN
        v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
    END IF;

    BEGIN
      v_default_poll := NULLIF(v_defaults->>'poll_seconds', '')::INT;
    EXCEPTION
      WHEN others THEN
        v_default_poll := NULL;
    END;

    BEGIN
      v_default_max_wait := NULLIF(v_defaults->>'max_wait_seconds', '')::INT;
    EXCEPTION
      WHEN others THEN
        v_default_max_wait := NULL;
    END;

    IF v_default_poll IS NULL OR v_default_max_wait IS NULL THEN
        RAISE EXCEPTION 'execute_label_job_v1: workflow_defaults poll/max_wait missing';
    END IF;

    v_poll_seconds := COALESCE(NULLIF(v_metadata->>'poll_interval_seconds', '')::INT, v_default_poll);
    v_max_wait_seconds := COALESCE(NULLIF(v_metadata->>'max_wait_seconds', '')::INT, v_default_max_wait);
    v_total_wait := GREATEST(0, (extract(epoch FROM (v_now - p_step.enqueued_at)))::INT);

    IF v_label_record.status = 'succeeded' THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'status', v_label_record.status,
            'label_job_id', v_label_record.id,
            'file_url', v_label_record.output_file_url,
            'renderer_metadata', v_label_record.renderer_metadata
        );
        RETURN v_response;
    ELSIF v_label_record.status = 'failed' THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := COALESCE(v_label_record.error_reason, 'label_generation_failed');
        v_response.operation_result := jsonb_build_object(
            'status', v_label_record.status,
            'label_job_id', v_label_record.id,
            'error_reason', v_label_record.error_reason
        );
        RETURN v_response;
    ELSIF v_total_wait >= v_max_wait_seconds THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := 'label_generation_timeout';
        v_response.operation_result := jsonb_build_object(
            'status', v_label_record.status,
            'label_job_id', v_label_record.id,
            'error_reason', 'timeout'
        );
        RETURN v_response;
    ELSE
        v_response.status := 'pending';
        v_response.next_run_at := v_now + make_interval(secs => GREATEST(v_poll_seconds, 15));
        v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
        v_response.operation_result := jsonb_build_object(
            'status', v_label_record.status,
            'label_job_id', v_label_record.id,
            'next_poll_seconds', GREATEST(v_poll_seconds, 15)
        );
        RETURN v_response;
    END IF;
END;
$$;

COMMIT;
