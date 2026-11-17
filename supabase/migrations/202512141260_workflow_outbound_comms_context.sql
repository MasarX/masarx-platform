-- Migration: Enrich comms_whatsapp outbound_calls context (opt-out + compliance readiness)
-- Purpose:
--   - Ensure workflow-originated WhatsApp sends carry client/recipient identifiers in outbound_calls.context.
--   - Populate outbound_calls.shipment_id when available from workflow context (enables opt-out enforcement).
-- Date: 2025-12-14

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

    v_priority := COALESCE(
        NULLIF(p_step.metadata->>'priority', '')::INT,
        90
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

COMMIT;

