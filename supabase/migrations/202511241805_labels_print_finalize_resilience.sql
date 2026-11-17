-- Migration: Labels print finalize resilience and hardcoding cleanup
-- Purpose:
--  - Make finalize handler resilient to missing bundle_response in context by
--    deriving from prior step rows when needed (row-driven SoT precedence).
--  - Replace hardcoded retry fallbacks in legacy worker actions with settings-driven
--    resolution via resolve_settings() (tenant -> global ladder).

BEGIN;

-- ============================================================================
-- Finalize handler: derive bundle outcome from prior steps when context is sparse
-- ============================================================================

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_finalize_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_response public.workflow_handler_response;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_label_state JSONB := COALESCE(v_context->'label_print', '{}'::jsonb);
    v_bundle JSONB := COALESCE(v_label_state->'bundle_response', '{}'::jsonb);
    v_counts JSONB := COALESCE(v_label_state->'counts', '{}'::jsonb);
    v_errors JSONB := jsonb_build_object(
        'out_of_scope', COALESCE(v_label_state->'out_of_scope', '[]'::jsonb),
        'invalid_boxes', COALESCE(v_label_state->'invalid_boxes', '[]'::jsonb),
        'timed_out', COALESCE(v_label_state->'timed_out', '[]'::jsonb)
    );
    v_ready JSONB := COALESCE(v_label_state->'ready', '[]'::jsonb);
    v_org_id UUID := NULLIF(v_label_state->>'organization_id', '')::uuid;
    v_requested_by UUID := NULLIF(v_context->>'requested_by', '')::uuid;
    v_correlation_id TEXT := NULLIF(v_context->>'correlation_id', '');
    v_signed_url TEXT;
    v_file_path TEXT;
    v_bundle_id UUID;
    v_included JSONB := '[]'::jsonb;
    v_step_bundle_result JSONB;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_print_finalize_v1: organization_id missing';
    END IF;

    -- If context lacks bundle_response, derive from the most recent label_bundle step
    IF v_bundle IS NULL OR jsonb_typeof(v_bundle) <> 'object' OR (v_bundle ? 'bundle_id') IS FALSE THEN
        SELECT COALESCE(operation_result->'bundle', operation_result)
        INTO v_step_bundle_result
        FROM public.workflow_run_steps
        WHERE workflow_run_id = p_run.id
          AND handler_key = 'label_bundle'
        ORDER BY sequence_order DESC
        LIMIT 1;

        v_bundle := COALESCE(v_step_bundle_result, v_bundle, '{}'::jsonb);
    END IF;

    v_signed_url := v_bundle->>'signed_url';
    v_file_path  := COALESCE(v_bundle->>'file_path', v_bundle->>'file_url');
    v_bundle_id  := COALESCE(NULLIF(v_bundle->>'bundle_id', '')::uuid, gen_random_uuid());

    v_included := (
        SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'shipment_id', elem->>'shipment_id',
            'label_ids', jsonb_build_array(elem->'label_id')
        ))), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(v_ready, '[]'::jsonb)) elem
    );

    PERFORM record_label_print(
        p_bundle_id := v_bundle_id,
        p_org_id := v_org_id,
        p_requested_by := v_requested_by,
        p_correlation_id := v_correlation_id,
        p_signed_url := v_signed_url,
        p_file_path := v_file_path,
        p_counts := v_counts,
        p_errors := v_errors,
        p_included := COALESCE(v_included, '[]'::jsonb)
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'ok',
        'bundle_id', v_bundle_id,
        'signed_url', v_signed_url,
        'file_path', v_file_path,
        'counts', v_counts,
        'errors', v_errors
    ));

    RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_finalize_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Finalize label print workflow: log decisions, record shipment actions, and surface bundle link; resilient to sparse context.';

-- ============================================================================
-- Legacy worker actions: remove hardcoded retry fallbacks -> resolve_settings
-- ============================================================================

-- call_supplier_api: resolve max_retries via ladder (tenant -> global)
CREATE OR REPLACE FUNCTION worker_action_call_supplier_api(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_operation_text TEXT;
    v_operation_id UUID;
    v_operation operation_templates%ROWTYPE;
    v_outbound_id UUID;
    v_priority INT := 100;
    v_max_retries INT := NULL;
    v_org UUID := NULL;
    v_correlation UUID := NULL;
BEGIN
    v_operation_text := COALESCE(
        p_action->>'operation_template_id',
        p_action->'arguments'->>'operation_template_id'
    );

    IF v_operation_text IS NULL OR btrim(v_operation_text) = '' THEN
        RETURN jsonb_build_object(
            'handler_key', 'call_supplier_api',
            'status', 'skipped',
            'reason', 'missing_operation_template_id'
        );
    END IF;

    BEGIN
        v_operation_id := v_operation_text::UUID;
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'handler_key', 'call_supplier_api',
            'status', 'skipped',
            'reason', 'invalid_operation_template_id'
        );
    END;

    SELECT * INTO v_operation
    FROM operation_templates
    WHERE id = v_operation_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'handler_key', 'call_supplier_api',
            'status', 'skipped',
            'reason', 'operation_template_not_found'
        );
    END IF;

    BEGIN
        v_priority := COALESCE((p_action->'arguments'->>'priority')::INT, 100);
    EXCEPTION WHEN OTHERS THEN
        v_priority := 100;
    END;

    -- Resolve organization from context for settings ladder
    IF p_context ? 'organization_id' AND (p_context->>'organization_id') <> '' THEN
        BEGIN
            v_org := (p_context->>'organization_id')::UUID;
        EXCEPTION WHEN OTHERS THEN
            v_org := NULL;
        END;
    END IF;

    -- Settings-driven retries: step arg -> tenant defaults -> global defaults
    v_max_retries := COALESCE(
        (p_action->'arguments'->>'max_retries')::INT,
        CASE
            WHEN v_org IS NOT NULL THEN NULLIF(resolve_settings('workflow_defaults', 'tenant', v_org)->>'max_retries', '')::INT
            ELSE NULL
        END,
        NULLIF(resolve_settings('workflow_defaults', 'global', NULL)->>'max_retries', '')::INT
    );

    INSERT INTO outbound_calls (
        call_type, target_type, target_id, method, url, headers, body,
        priority, max_retries, context, correlation_id
    )
    VALUES (
        'provider_api', 'provider', v_operation.provider_id,
        v_operation.method, v_operation.url_template,
        COALESCE(v_operation.headers_template, '{}'::jsonb),
        COALESCE(v_operation.body_template, '{}'::jsonb),
        v_priority, v_max_retries,
        jsonb_build_object(
            'webhook_id', p_webhook_id,
            'action', p_action,
            'transformed_payload', p_context->'transformed_payload'
        ),
        CASE WHEN p_context ? 'correlation_id' AND (p_context->>'correlation_id') <> ''
             THEN (p_context->>'correlation_id')::UUID ELSE NULL END
    ) RETURNING id INTO v_outbound_id;

    IF p_context ? 'correlation_id' AND (p_context->>'correlation_id') <> '' THEN
        BEGIN v_correlation := (p_context->>'correlation_id')::UUID; EXCEPTION WHEN OTHERS THEN v_correlation := NULL; END;
    END IF;

    IF v_org IS NOT NULL THEN
        PERFORM log_decision(
            p_organization_id := v_org,
            p_decision_category := 'webhook_processing',
            p_resource_type := 'webhook_inbox',
            p_resource_id := p_webhook_id,
            p_decision_point := 'workflow_followup_action:call_supplier_api',
            p_decision_outcome := 'create_job',
            p_performed_by_system := 'webhook_processor_worker',
            p_correlation_id := v_correlation,
            p_decision_inputs := jsonb_build_object('action', p_action, 'outbound_call_id', v_outbound_id),
            p_decision_reason := NULL
        );
    END IF;

    RETURN jsonb_build_object('handler_key','call_supplier_api','status','queued','outbound_call_id',v_outbound_id);
END;
$$;

COMMENT ON FUNCTION worker_action_call_supplier_api(UUID, JSONB, JSONB)
    IS 'Queue supplier API call via outbound_calls; max_retries resolved by settings ladder (no hardcoding).';

-- geocode_enrich: resolve max_retries via ladder (tenant -> global)
CREATE OR REPLACE FUNCTION worker_action_geocode_enrich(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_provider_text TEXT;
    v_provider_id UUID;
    v_url TEXT;
    v_method TEXT;
    v_outbound_id UUID;
    v_org UUID := NULL;
    v_correlation UUID := NULL;
BEGIN
    v_provider_text := COALESCE(p_action->>'provider_id', p_action->'arguments'->>'provider_id');
    IF v_provider_text IS NULL OR btrim(v_provider_text) = '' THEN
        RETURN jsonb_build_object('handler_key','geocode_enrich','status','skipped','reason','missing_provider_id');
    END IF;
    BEGIN v_provider_id := v_provider_text::UUID; EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('handler_key','geocode_enrich','status','skipped','reason','invalid_provider_id');
    END;

    v_url := COALESCE(p_action->'arguments'->>'url','geocode://provider');
    v_method := COALESCE(upper(p_action->'arguments'->>'method'),'POST');

    IF p_context ? 'organization_id' AND (p_context->>'organization_id') <> '' THEN
        BEGIN v_org := (p_context->>'organization_id')::UUID; EXCEPTION WHEN OTHERS THEN v_org := NULL; END;
    END IF;

    INSERT INTO outbound_calls (
        call_type, target_type, target_id, method, url, headers, body,
        priority, max_retries, context, correlation_id
    )
    VALUES (
        'provider_api','provider', v_provider_id,
        v_method, v_url,
        COALESCE(p_action->'arguments'->'headers','{}'::jsonb),
        COALESCE(p_action->'arguments'->'payload','{}'::jsonb),
        COALESCE((p_action->'arguments'->>'priority')::INT, 90),
        COALESCE(
            (p_action->'arguments'->>'max_retries')::INT,
            CASE
                WHEN v_org IS NOT NULL THEN NULLIF(resolve_settings('workflow_defaults','tenant', v_org)->>'max_retries','')::INT
                ELSE NULL
            END,
            NULLIF(resolve_settings('workflow_defaults','global', NULL)->>'max_retries','')::INT
        ),
        jsonb_build_object('webhook_id', p_webhook_id, 'action', p_action, 'transformed_payload', p_context->'transformed_payload'),
        CASE WHEN p_context ? 'correlation_id' AND (p_context->>'correlation_id') <> ''
             THEN (p_context->>'correlation_id')::UUID ELSE NULL END
    ) RETURNING id INTO v_outbound_id;

    IF p_context ? 'correlation_id' AND (p_context->>'correlation_id') <> '' THEN
        BEGIN v_correlation := (p_context->>'correlation_id')::UUID; EXCEPTION WHEN OTHERS THEN v_correlation := NULL; END;
    END IF;

    IF v_org IS NOT NULL THEN
        PERFORM log_decision(
            p_organization_id := v_org,
            p_decision_category := 'webhook_processing',
            p_resource_type := 'webhook_inbox',
            p_resource_id := p_webhook_id,
            p_decision_point := 'workflow_followup_action:geocode_enrich',
            p_decision_outcome := 'create_job',
            p_performed_by_system := 'webhook_processor_worker',
            p_correlation_id := v_correlation,
            p_decision_inputs := jsonb_build_object('action', p_action, 'outbound_call_id', v_outbound_id),
            p_decision_reason := NULL
        );
    END IF;

    RETURN jsonb_build_object('handler_key','geocode_enrich','status','queued','outbound_call_id', v_outbound_id);
END;
$$;

COMMENT ON FUNCTION worker_action_geocode_enrich(UUID, JSONB, JSONB)
    IS 'Queue geocoding via outbound_calls; max_retries resolved by settings ladder (no hardcoding).';

COMMIT;
