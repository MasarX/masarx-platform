-- Migration: workflow follow-up actions workflow wrapper
-- Purpose: Route workflow follow-up actions through workflow engine exclusively.
-- Date: 2025-11-14

BEGIN;

-- Upsert canonical template that will host dynamic workflow follow-up steps
WITH upsert_template AS (
    INSERT INTO workflow_templates (
        id,
        name,
        description,
        version,
        status,
        scope_type,
        scope_id,
        notes
    )
    VALUES (
        '99990000-0000-0000-0000-000000340000',
        'workflow_followup_actions_wrapper_v1',
        'Dynamic workflow that materialises webhook workflow follow-up actions into workflow steps.',
        1,
        'active',
        'global',
        NULL,
        'Auto-generated. Steps are created dynamically per webhook actions.'
    )
    ON CONFLICT (name) DO UPDATE
        SET status = 'active',
            notes = EXCLUDED.notes,
            scope_type = EXCLUDED.scope_type,
            scope_id = EXCLUDED.scope_id,
            updated_at = workflow_now()
    RETURNING id
)
SELECT id FROM upsert_template
UNION ALL
SELECT id
FROM workflow_templates
WHERE name = 'workflow_followup_actions_wrapper_v1'
LIMIT 1;

DO $$
BEGIN
    PERFORM 1
    FROM pg_type
    WHERE typname = 'workflow_handler_response'
      AND typnamespace = 'public'::regnamespace;
    IF NOT FOUND THEN
        CREATE TYPE public.workflow_handler_response AS (
            status TEXT,
            operation_result JSONB,
            context_patch JSONB,
            workflow_status TEXT,
            retry_attempt INT,
            next_run_at TIMESTAMPTZ,
            last_error TEXT
        );
    END IF;
END;
$$;
-- Handler: workflow_followup_notification (outbound comms)
CREATE OR REPLACE FUNCTION workflow_handlers.execute_workflow_followup_notification_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
SECURITY DEFINER
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_channel TEXT := lower(NULLIF(v_metadata->>'channel', ''));
    v_recipient_id UUID;
    v_priority INT := COALESCE(NULLIF(v_metadata->>'priority', '')::INT, 100);
    v_payload JSONB := COALESCE(v_metadata->'payload', '{}'::jsonb);
    v_max_retries INT := COALESCE(NULLIF(v_metadata->>'max_retries', '')::INT, p_step.max_retries);
    v_outbound_id UUID;
    v_response public.workflow_handler_response;
    v_now TIMESTAMPTZ := now();
    v_org UUID;
    v_correlation UUID;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    IF v_channel IS NULL OR v_channel NOT IN ('sms', 'whatsapp', 'email', 'voice', 'push') THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := format('invalid_channel:%s', COALESCE(v_channel, 'null'));
        RETURN v_response;
    END IF;

    BEGIN
        v_recipient_id := (v_metadata->>'recipient_id')::UUID;
    EXCEPTION
        WHEN OTHERS THEN
            v_response.status := 'failed';
            v_response.workflow_status := 'failed';
            v_response.last_error := 'invalid_recipient_id';
            RETURN v_response;
    END;

    INSERT INTO outbound_calls (
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
        'comms_' || v_channel,
        'recipient',
        v_recipient_id,
        'POST',
        format('comms://%s', v_channel),
        '{}'::jsonb,
        v_payload,
        v_priority,
        GREATEST(v_max_retries, 1),
        jsonb_build_object(
            'workflow_run_id', p_step.workflow_run_id,
            'workflow_run_step_id', p_step.id,
            'source', 'workflow_followup_notification'
        ),
        CASE
            WHEN p_run.context ? 'correlation_id' THEN NULLIF(p_run.context->>'correlation_id', '')::UUID
            ELSE NULL
        END,
        p_step.id
    )
    RETURNING id INTO v_outbound_id;

    UPDATE workflow_run_steps
    SET operation_result = jsonb_build_object(
            'outbound_call_id', v_outbound_id,
            'channel', v_channel,
            'recipient_id', v_recipient_id
        ),
        max_retries = GREATEST(v_max_retries, p_step.max_retries),
        updated_at = v_now
    WHERE id = p_step.id;

    IF p_run.context ? 'organization_id' THEN
        BEGIN
            v_org := NULLIF(p_run.context->>'organization_id', '')::UUID;
        EXCEPTION WHEN OTHERS THEN v_org := NULL;
        END;
    END IF;

    IF p_run.context ? 'correlation_id' THEN
        BEGIN
            v_correlation := NULLIF(p_run.context->>'correlation_id', '')::UUID;
        EXCEPTION WHEN OTHERS THEN v_correlation := NULL;
        END;
    END IF;

    IF v_org IS NOT NULL THEN
        PERFORM log_decision(
            p_organization_id := v_org,
            p_decision_category := 'webhook_processing',
            p_resource_type := 'webhook_inbox',
            p_resource_id := COALESCE(NULLIF(p_run.context->>'webhook_id', '')::UUID, NULL),
            p_decision_point := 'workflow_followup_action:enqueue_notification',
            p_decision_outcome := 'workflow_enqueued',
            p_performed_by_system := 'workflow_engine',
            p_correlation_id := v_correlation,
            p_decision_inputs := jsonb_build_object(
                'workflow_run_id', p_step.workflow_run_id,
                'workflow_run_step_id', p_step.id,
                'channel', v_channel,
                'recipient_id', v_recipient_id,
                'outbound_call_id', v_outbound_id
            ),
            p_decision_reason := NULL
        );
    END IF;

    v_response.status := 'in_progress';
    v_response.operation_result := jsonb_build_object(
        'outbound_call_id', v_outbound_id,
        'channel', v_channel,
        'recipient_id', v_recipient_id
    );
    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_workflow_followup_notification_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Workflow handler that enqueues workflow follow-up communication jobs and binds them to workflow history.';
-- Handler: workflow_followup_geocode (provider enrichment)
CREATE OR REPLACE FUNCTION workflow_handlers.execute_workflow_followup_geocode_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
SECURITY DEFINER
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_provider_id UUID;
    v_method TEXT := COALESCE(upper(NULLIF(v_metadata->>'method', '')), 'POST');
    v_url TEXT := COALESCE(NULLIF(v_metadata->>'url', ''), 'geocode://provider');
    v_headers JSONB := COALESCE(v_metadata->'headers', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_metadata->'payload', '{}'::jsonb);
    v_priority INT := COALESCE(NULLIF(v_metadata->>'priority', '')::INT, 90);
    v_max_retries INT := COALESCE(NULLIF(v_metadata->>'max_retries', '')::INT, 2);
    v_outbound_id UUID;
    v_response public.workflow_handler_response;
    v_now TIMESTAMPTZ := now();
    v_org UUID;
    v_correlation UUID;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    BEGIN
        v_provider_id := (v_metadata->>'provider_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := 'invalid_provider_id';
        RETURN v_response;
    END;

    INSERT INTO outbound_calls (
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
        'provider_api',
        'provider',
        v_provider_id,
        v_method,
        v_url,
        v_headers,
        v_payload,
        v_priority,
        GREATEST(v_max_retries, 1),
        jsonb_build_object(
            'workflow_run_id', p_step.workflow_run_id,
            'workflow_run_step_id', p_step.id,
            'source', 'workflow_followup_geocode'
        ),
        CASE
            WHEN p_run.context ? 'correlation_id' THEN NULLIF(p_run.context->>'correlation_id', '')::UUID
            ELSE NULL
        END,
        p_step.id
    )
    RETURNING id INTO v_outbound_id;

    UPDATE workflow_run_steps
    SET operation_result = jsonb_build_object(
            'outbound_call_id', v_outbound_id,
            'provider_id', v_provider_id
        ),
        max_retries = GREATEST(v_max_retries, p_step.max_retries),
        updated_at = v_now
    WHERE id = p_step.id;

    IF p_run.context ? 'organization_id' THEN
        BEGIN
            v_org := NULLIF(p_run.context->>'organization_id', '')::UUID;
        EXCEPTION WHEN OTHERS THEN v_org := NULL;
        END;
    END IF;

    IF p_run.context ? 'correlation_id' THEN
        BEGIN
            v_correlation := NULLIF(p_run.context->>'correlation_id', '')::UUID;
        EXCEPTION WHEN OTHERS THEN v_correlation := NULL;
        END;
    END IF;

    IF v_org IS NOT NULL THEN
        PERFORM log_decision(
            p_organization_id := v_org,
            p_decision_category := 'webhook_processing',
            p_resource_type := 'webhook_inbox',
            p_resource_id := COALESCE(NULLIF(p_run.context->>'webhook_id', '')::UUID, NULL),
            p_decision_point := 'workflow_followup_action:geocode_enrich',
            p_decision_outcome := 'workflow_enqueued',
            p_performed_by_system := 'workflow_engine',
            p_correlation_id := v_correlation,
            p_decision_inputs := jsonb_build_object(
                'workflow_run_id', p_step.workflow_run_id,
                'workflow_run_step_id', p_step.id,
                'provider_id', v_provider_id,
                'outbound_call_id', v_outbound_id
            ),
            p_decision_reason := NULL
        );
    END IF;

    v_response.status := 'in_progress';
    v_response.operation_result := jsonb_build_object(
        'outbound_call_id', v_outbound_id,
        'provider_id', v_provider_id
    );
    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_workflow_followup_geocode_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Workflow handler that enqueues workflow follow-up geocode enrichment jobs and links them to workflow history.';
-- Register handler implementations
INSERT INTO operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
)
VALUES
    (
        'workflow_followup_notification',
        'workflow_handlers',
        'execute_workflow_followup_notification_v1',
        '(public.workflow_run_steps,public.workflow_runs,jsonb)',
        'v1',
        TRUE,
        'Workflow handler that enqueues workflow follow-up communications jobs.',
        'docs/ops/runbooks/workflow_engine_runbook.md'
    ),
    (
        'workflow_followup_geocode',
        'workflow_handlers',
        'execute_workflow_followup_geocode_v1',
        '(public.workflow_run_steps,public.workflow_runs,jsonb)',
        'v1',
        TRUE,
        'Workflow handler that enqueues workflow follow-up geocode enrichment jobs.',
        'docs/ops/runbooks/geocoding_worker.md'
    )
ON CONFLICT (handler_key) DO UPDATE
    SET handler_schema = EXCLUDED.handler_schema,
        handler_name = EXCLUDED.handler_name,
        handler_signature = EXCLUDED.handler_signature,
        handler_version = EXCLUDED.handler_version,
        is_active = TRUE,
        notes = EXCLUDED.notes,
        doc_url = EXCLUDED.doc_url;

-- Template steps catalogue (disabled - used only for metadata lookups)
INSERT INTO workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    enabled,
    metadata,
    handler_key,
    handler_version
)
VALUES
    (
        '99990000-0000-0000-0000-000000340101',
        '99990000-0000-0000-0000-000000340000',
        1,
        'workflow_followup_call_supplier_api',
        'operation_template',
        'success',
        FALSE,
        jsonb_build_object('catalog', 'workflow_followup_call_supplier_api'),
        'outbound_http',
        'v1'
    ),
    (
        '99990000-0000-0000-0000-000000340102',
        '99990000-0000-0000-0000-000000340000',
        2,
        'workflow_followup_enqueue_notification',
        'notification',
        'success',
        FALSE,
        jsonb_build_object('catalog', 'workflow_followup_enqueue_notification'),
        'workflow_followup_notification',
        'v1'
    ),
    (
        '99990000-0000-0000-0000-000000340103',
        '99990000-0000-0000-0000-000000340000',
        3,
        'workflow_followup_geocode_enrich',
        'geocode',
        'success',
        FALSE,
        jsonb_build_object('catalog', 'workflow_followup_geocode_enrich'),
        'workflow_followup_geocode',
        'v1'
    ),
    (
        '99990000-0000-0000-0000-000000340104',
        '99990000-0000-0000-0000-000000340000',
        4,
        'workflow_followup_start_workflow',
        'workflow',
        'success',
        FALSE,
        jsonb_build_object('catalog', 'workflow_followup_start_workflow'),
        'start_workflow',
        'v1'
    )
ON CONFLICT (id) DO UPDATE
    SET handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        metadata = EXCLUDED.metadata,
        operation_settings_category = EXCLUDED.operation_settings_category;
-- Helper: start_workflow_followup_actions_workflow
CREATE OR REPLACE FUNCTION public.start_workflow_followup_actions_workflow(
    p_webhook_id UUID,
    p_actions JSONB,
    p_context JSONB
)
RETURNS JSONB
SECURITY DEFINER
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_actions JSONB := COALESCE(p_actions, '[]'::jsonb);
    v_results JSONB := '[]'::jsonb;
    v_action JSONB;
    v_template_id UUID;
    v_run_id UUID;
    v_sequence INT := 0;
    v_step_id UUID;
    v_step_template_id UUID;
    v_handler_key TEXT;
    v_metadata JSONB;
    v_now TIMESTAMPTZ := now();
    v_org UUID;
    v_correlation UUID;
    v_operation_template_id UUID;
    v_priority INT;
    v_max_retries INT;
    v_channel TEXT;
    v_recipient_id UUID;
    v_provider_id UUID;
    v_context JSONB := COALESCE(p_context, '{}'::jsonb);
    v_context_patch JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    IF jsonb_typeof(v_actions) <> 'array' OR jsonb_array_length(v_actions) = 0 THEN
        RETURN '[]'::jsonb;
    END IF;

    SELECT id INTO v_template_id
    FROM workflow_templates
    WHERE name = 'workflow_followup_actions_wrapper_v1';

    IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'workflow_followup_actions_wrapper_v1 template missing';
    END IF;

    v_run_id := start_workflow_run(
        v_template_id,
        jsonb_strip_nulls(jsonb_build_object(
            'webhook_id', p_webhook_id,
            'workflow_followup_actions', v_actions,
            'transformed_payload', v_context->'transformed_payload',
            'organization_id', NULLIF(v_context->>'organization_id', ''),
            'correlation_id', NULLIF(v_context->>'correlation_id', '')
        ))
    );

    UPDATE webhook_inbox
    SET workflow_followup_workflow_run_id = v_run_id
    WHERE id = p_webhook_id;

    BEGIN
        v_org := NULLIF(v_context->>'organization_id', '')::UUID;
    EXCEPTION WHEN OTHERS THEN v_org := NULL;
    END;

    BEGIN
        v_correlation := NULLIF(v_context->>'correlation_id', '')::UUID;
    EXCEPTION WHEN OTHERS THEN v_correlation := NULL;
    END;

    FOR v_action IN
        SELECT jsonb_array_elements(v_actions)
    LOOP
        v_sequence := v_sequence + 1;
        v_handler_key := lower(trim(COALESCE(v_action->>'handler_key', '')));

        IF v_handler_key = '' THEN
            v_results := v_results || jsonb_build_array(
                jsonb_build_object(
                    'handler_key', NULL,
                    'status', 'skipped',
                    'reason', 'missing_handler_key'
                )
            );
            CONTINUE;
        END IF;

        IF v_handler_key = 'call_supplier_api' THEN
            SELECT id INTO v_step_template_id
            FROM workflow_template_steps
            WHERE id = '99990000-0000-0000-0000-000000340101';

            BEGIN
                v_operation_template_id := COALESCE(
                    NULLIF(v_action->>'operation_template_id', '')::UUID,
                    NULLIF(v_action->'arguments'->>'operation_template_id', '')::UUID
                );
            EXCEPTION WHEN OTHERS THEN
                v_operation_template_id := NULL;
            END;

            IF v_operation_template_id IS NULL THEN
                v_results := v_results || jsonb_build_array(
                    jsonb_build_object(
                        'handler_key', 'call_supplier_api',
                        'status', 'skipped',
                        'reason', 'missing_operation_template_id'
                    )
                );
                CONTINUE;
            END IF;

            v_priority := COALESCE((v_action->'arguments'->>'priority')::INT, NULL);
            v_max_retries := COALESCE((v_action->'arguments'->>'max_retries')::INT, NULL);

            v_metadata := jsonb_strip_nulls(jsonb_build_object(
                'operation_template_id', v_operation_template_id,
                'priority', v_priority,
                'max_retries', v_max_retries,
                'payload_path', COALESCE(v_action->'arguments'->>'payload_path', NULL),
                'call_type', COALESCE(v_action->'arguments'->>'call_type', NULL),
                'expects_provider_defaults', v_action->'arguments'->>'expects_provider_defaults'
            ));

            v_step_id := gen_random_uuid();

            INSERT INTO workflow_run_steps (
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
                enqueued_at,
                created_at,
                updated_at
            )
            VALUES (
                v_step_id,
                v_run_id,
                v_step_template_id,
                v_sequence,
                'pending',
                'workflow_followup_call_supplier_api',
                COALESCE(v_max_retries, 3),
                v_metadata,
                'outbound_http',
                'v1',
                v_now,
                v_now,
                v_now
            );

            IF v_org IS NOT NULL THEN
                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'webhook_processing',
                    p_resource_type := 'webhook_inbox',
                    p_resource_id := p_webhook_id,
                    p_decision_point := 'workflow_followup_action:call_supplier_api',
                    p_decision_outcome := 'workflow_enqueued',
                    p_performed_by_system := 'workflow_engine',
                    p_correlation_id := v_correlation,
                    p_decision_inputs := jsonb_build_object(
                        'workflow_run_id', v_run_id,
                        'workflow_run_step_id', v_step_id,
                        'operation_template_id', v_operation_template_id
                    ),
                    p_decision_reason := NULL
                );
            END IF;

            v_results := v_results || jsonb_build_array(
                jsonb_build_object(
                    'handler_key', 'call_supplier_api',
                    'status', 'workflow_enqueued',
                    'workflow_run_id', v_run_id,
                    'workflow_run_step_id', v_step_id,
                    'operation_template_id', v_operation_template_id
                )
            );
            CONTINUE;
        END IF;

        IF v_handler_key = 'enqueue_notification' THEN
            SELECT id INTO v_step_template_id
            FROM workflow_template_steps
            WHERE id = '99990000-0000-0000-0000-000000340102';

            v_channel := lower(COALESCE(
                NULLIF(v_action->>'channel', ''),
                NULLIF(v_action->'arguments'->>'channel', '')
            ));

            IF v_channel IS NULL OR v_channel NOT IN ('sms', 'whatsapp', 'email', 'voice', 'push') THEN
                v_results := v_results || jsonb_build_array(
                    jsonb_build_object(
                        'handler_key', 'enqueue_notification',
                        'status', 'skipped',
                        'reason', 'invalid_channel'
                    )
                );
                CONTINUE;
            END IF;

            BEGIN
                v_recipient_id := COALESCE(
                    NULLIF(v_action->'arguments'->>'recipient_id', '')::UUID,
                    NULLIF(v_action->>'recipient_id', '')::UUID
                );
            EXCEPTION WHEN OTHERS THEN
                v_recipient_id := NULL;
            END;

            IF v_recipient_id IS NULL THEN
                v_results := v_results || jsonb_build_array(
                    jsonb_build_object(
                        'handler_key', 'enqueue_notification',
                        'status', 'skipped',
                        'reason', 'missing_recipient_id'
                    )
                );
                CONTINUE;
            END IF;

            v_priority := COALESCE((v_action->'arguments'->>'priority')::INT, NULL);
            v_max_retries := COALESCE((v_action->'arguments'->>'max_retries')::INT, NULL);

            v_metadata := jsonb_strip_nulls(jsonb_build_object(
                'channel', v_channel,
                'recipient_id', v_recipient_id,
                'payload', COALESCE(v_action->'arguments'->'payload', '{}'::jsonb),
                'priority', v_priority,
                'max_retries', v_max_retries
            ));

            v_step_id := gen_random_uuid();

            INSERT INTO workflow_run_steps (
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
                enqueued_at,
                created_at,
                updated_at
            )
            VALUES (
                v_step_id,
                v_run_id,
                v_step_template_id,
                v_sequence,
                'pending',
                'workflow_followup_enqueue_notification',
                COALESCE(v_max_retries, 3),
                v_metadata,
                'workflow_followup_notification',
                'v1',
                v_now,
                v_now,
                v_now
            );

            IF v_org IS NOT NULL THEN
                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'webhook_processing',
                    p_resource_type := 'webhook_inbox',
                    p_resource_id := p_webhook_id,
                    p_decision_point := 'workflow_followup_action:enqueue_notification',
                    p_decision_outcome := 'workflow_enqueued',
                    p_performed_by_system := 'workflow_engine',
                    p_correlation_id := v_correlation,
                    p_decision_inputs := jsonb_build_object(
                        'workflow_run_id', v_run_id,
                        'workflow_run_step_id', v_step_id,
                        'channel', v_channel,
                        'recipient_id', v_recipient_id
                    ),
                    p_decision_reason := NULL
                );
            END IF;

            v_results := v_results || jsonb_build_array(
                jsonb_build_object(
                    'handler_key', 'enqueue_notification',
                    'status', 'workflow_enqueued',
                    'workflow_run_id', v_run_id,
                    'workflow_run_step_id', v_step_id,
                    'channel', v_channel,
                    'recipient_id', v_recipient_id
                )
            );
            CONTINUE;
        END IF;
        IF v_handler_key = 'geocode_enrich' THEN
            SELECT id INTO v_step_template_id
            FROM workflow_template_steps
            WHERE id = '99990000-0000-0000-0000-000000340103';

            BEGIN
                v_provider_id := COALESCE(
                    NULLIF(v_action->>'provider_id', '')::UUID,
                    NULLIF(v_action->'arguments'->>'provider_id', '')::UUID
                );
            EXCEPTION WHEN OTHERS THEN
                v_provider_id := NULL;
            END;

            IF v_provider_id IS NULL THEN
                v_results := v_results || jsonb_build_array(
                    jsonb_build_object(
                        'handler_key', 'geocode_enrich',
                        'status', 'skipped',
                        'reason', 'missing_provider_id'
                    )
                );
                CONTINUE;
            END IF;

            v_metadata := jsonb_strip_nulls(jsonb_build_object(
                'provider_id', v_provider_id,
                'url', COALESCE(v_action->'arguments'->>'url', NULL),
                'method', COALESCE(v_action->'arguments'->>'method', NULL),
                'headers', COALESCE(v_action->'arguments'->'headers', '{}'::jsonb),
                'payload', COALESCE(v_action->'arguments'->'payload', '{}'::jsonb),
                'priority', COALESCE((v_action->'arguments'->>'priority')::INT, NULL),
                'max_retries', COALESCE((v_action->'arguments'->>'max_retries')::INT, NULL)
            ));

            v_step_id := gen_random_uuid();

            INSERT INTO workflow_run_steps (
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
                enqueued_at,
                created_at,
                updated_at
            )
            VALUES (
                v_step_id,
                v_run_id,
                v_step_template_id,
                v_sequence,
                'pending',
                'workflow_followup_geocode_enrich',
                COALESCE((v_action->'arguments'->>'max_retries')::INT, 2),
                v_metadata,
                'workflow_followup_geocode',
                'v1',
                v_now,
                v_now,
                v_now
            );

            IF v_org IS NOT NULL THEN
                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'webhook_processing',
                    p_resource_type := 'webhook_inbox',
                    p_resource_id := p_webhook_id,
                    p_decision_point := 'workflow_followup_action:geocode_enrich',
                    p_decision_outcome := 'workflow_enqueued',
                    p_performed_by_system := 'workflow_engine',
                    p_correlation_id := v_correlation,
                    p_decision_inputs := jsonb_build_object(
                        'workflow_run_id', v_run_id,
                        'workflow_run_step_id', v_step_id,
                        'provider_id', v_provider_id
                    ),
                    p_decision_reason := NULL
                );
            END IF;

            v_results := v_results || jsonb_build_array(
                jsonb_build_object(
                    'handler_key', 'geocode_enrich',
                    'status', 'workflow_enqueued',
                    'workflow_run_id', v_run_id,
                    'workflow_run_step_id', v_step_id,
                    'provider_id', v_provider_id
                )
            );
            CONTINUE;
        END IF;

        IF v_handler_key = 'start_workflow' THEN
            SELECT id INTO v_step_template_id
            FROM workflow_template_steps
            WHERE id = '99990000-0000-0000-0000-000000340104';

            BEGIN
                v_operation_template_id := COALESCE(
                    NULLIF(v_action->>'workflow_template_id', '')::UUID,
                    NULLIF(v_action->'arguments'->>'workflow_template_id', '')::UUID,
                    NULLIF(v_context->>'workflow_followup_workflow_id', '')::UUID
                );
            EXCEPTION WHEN OTHERS THEN
                v_operation_template_id := NULL;
            END;

            IF v_operation_template_id IS NULL THEN
                v_results := v_results || jsonb_build_array(
                    jsonb_build_object(
                        'handler_key', 'start_workflow',
                        'status', 'skipped',
                        'reason', 'missing_workflow_template_id'
                    )
                );
                CONTINUE;
            END IF;

            v_context_patch := COALESCE(v_action->'arguments'->'context', '{}'::jsonb);

            v_metadata := jsonb_strip_nulls(jsonb_build_object(
                'child_workflow_template_id', v_operation_template_id,
                'workflow_template_id', v_operation_template_id,
                'context_patch', v_context_patch
            ));

            v_step_id := gen_random_uuid();

            INSERT INTO workflow_run_steps (
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
                enqueued_at,
                created_at,
                updated_at
            )
            VALUES (
                v_step_id,
                v_run_id,
                v_step_template_id,
                v_sequence,
                'pending',
                'workflow_followup_start_workflow',
                COALESCE((v_action->'arguments'->>'max_retries')::INT, 3),
                v_metadata,
                'start_workflow',
                'v1',
                v_now,
                v_now,
                v_now
            );

            IF v_org IS NOT NULL THEN
                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'webhook_processing',
                    p_resource_type := 'webhook_inbox',
                    p_resource_id := p_webhook_id,
                    p_decision_point := 'workflow_followup_action:start_workflow',
                    p_decision_outcome := 'workflow_enqueued',
                    p_performed_by_system := 'workflow_engine',
                    p_correlation_id := v_correlation,
                    p_decision_inputs := jsonb_build_object(
                        'workflow_run_id', v_run_id,
                        'workflow_run_step_id', v_step_id,
                        'child_workflow_template_id', v_operation_template_id
                    ),
                    p_decision_reason := NULL
                );
            END IF;

            v_results := v_results || jsonb_build_array(
                jsonb_build_object(
                    'handler_key', 'start_workflow',
                    'status', 'workflow_enqueued',
                    'workflow_run_id', v_run_id,
                    'workflow_run_step_id', v_step_id,
                    'child_workflow_template_id', v_operation_template_id
                )
            );
            CONTINUE;
        END IF;

        v_results := v_results || jsonb_build_array(
            jsonb_build_object(
                'handler_key', v_handler_key,
                'status', 'skipped',
                'reason', 'handler_not_supported'
            )
        );
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM workflow_run_steps
        WHERE workflow_run_id = v_run_id
    ) THEN
        UPDATE workflow_runs
        SET workflow_status = 'completed',
            completed_at = v_now,
            updated_at = v_now
        WHERE id = v_run_id;
    END IF;

    RETURN v_results;
END;
$function$;

COMMENT ON FUNCTION public.start_workflow_followup_actions_workflow(UUID, JSONB, JSONB)
    IS 'Transforms workflow follow-up action definitions into workflow runs/steps and returns execution metadata.';
-- Remap execute_workflow_followup_actions to the workflow wrapper
CREATE OR REPLACE FUNCTION execute_workflow_followup_actions(
    p_webhook_id UUID,
    p_actions JSONB,
    p_context JSONB
)
RETURNS JSONB
SECURITY DEFINER
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
BEGIN
    RETURN start_workflow_followup_actions_workflow(p_webhook_id, p_actions, p_context);
END;
$function$;

COMMENT ON FUNCTION execute_workflow_followup_actions(UUID, JSONB, JSONB)
    IS 'Delegates workflow follow-up action execution to the workflow engine wrapper.';

-- Legacy worker helpers now delegate to the workflow wrapper
CREATE OR REPLACE FUNCTION worker_action_start_workflow(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
    RETURN COALESCE(
        (start_workflow_followup_actions_workflow(p_webhook_id, jsonb_build_array(p_action), p_context))->0,
        jsonb_build_object('handler_key', 'start_workflow', 'status', 'skipped', 'reason', 'no_actions_enqueued')
    );
END;
$function$;

COMMENT ON FUNCTION worker_action_start_workflow(UUID, JSONB, JSONB)
    IS 'Deprecated direct worker hook; delegates to workflow-based wrapper.';

CREATE OR REPLACE FUNCTION worker_action_call_supplier_api(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
    RETURN COALESCE(
        (start_workflow_followup_actions_workflow(p_webhook_id, jsonb_build_array(p_action), p_context))->0,
        jsonb_build_object('handler_key', 'call_supplier_api', 'status', 'skipped', 'reason', 'no_actions_enqueued')
    );
END;
$function$;

COMMENT ON FUNCTION worker_action_call_supplier_api(UUID, JSONB, JSONB)
    IS 'Deprecated direct worker hook; delegates to workflow-based wrapper.';

CREATE OR REPLACE FUNCTION worker_action_enqueue_notification(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
    RETURN COALESCE(
        (start_workflow_followup_actions_workflow(p_webhook_id, jsonb_build_array(p_action), p_context))->0,
        jsonb_build_object('handler_key', 'enqueue_notification', 'status', 'skipped', 'reason', 'no_actions_enqueued')
    );
END;
$function$;

COMMENT ON FUNCTION worker_action_enqueue_notification(UUID, JSONB, JSONB)
    IS 'Deprecated direct worker hook; delegates to workflow-based wrapper.';

CREATE OR REPLACE FUNCTION worker_action_geocode_enrich(
    p_webhook_id UUID,
    p_action JSONB,
    p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
    RETURN COALESCE(
        (start_workflow_followup_actions_workflow(p_webhook_id, jsonb_build_array(p_action), p_context))->0,
        jsonb_build_object('handler_key', 'geocode_enrich', 'status', 'skipped', 'reason', 'no_actions_enqueued')
    );
END;
$function$;

COMMENT ON FUNCTION worker_action_geocode_enrich(UUID, JSONB, JSONB)
    IS 'Deprecated direct worker hook; delegates to workflow-based wrapper.';

COMMIT;


