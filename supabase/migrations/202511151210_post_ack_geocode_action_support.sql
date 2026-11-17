-- Migration: workflow follow-up actions wrapper - add geocode_enrich support
-- Purpose: Materialize geocode_enrich workflow follow-up actions into workflow steps using workflow_followup_geocode handler
-- Date: 2025-11-15 12:10

BEGIN;

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
    v_method TEXT;
    v_url TEXT;
    v_headers JSONB;
    v_payload JSONB;
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

        -- call_supplier_api -> outbound_http
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

        -- enqueue_notification -> workflow_followup_notification
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
                    NULLIF(v_action->>'recipient_id', '')::UUID,
                    NULLIF(v_action->'arguments'->>'recipient_id', '')::UUID
                );
            EXCEPTION WHEN OTHERS THEN v_recipient_id := NULL;
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

        -- geocode_enrich -> workflow_followup_geocode
        IF v_handler_key = 'geocode_enrich' THEN
            SELECT id INTO v_step_template_id
            FROM workflow_template_steps
            WHERE id = '99990000-0000-0000-0000-000000340103';

            BEGIN
                v_provider_id := COALESCE(
                    NULLIF(v_action->>'provider_id', '')::UUID,
                    NULLIF(v_action->'arguments'->>'provider_id', '')::UUID
                );
            EXCEPTION WHEN OTHERS THEN v_provider_id := NULL;
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

            v_method := COALESCE(
                NULLIF(v_action->>'method', ''),
                NULLIF(v_action->'arguments'->>'method', ''),
                'POST'
            );
            v_url := COALESCE(
                NULLIF(v_action->>'url', ''),
                NULLIF(v_action->'arguments'->>'url', ''),
                'geocode://provider'
            );
            v_headers := COALESCE(v_action->'arguments'->'headers', '{}'::jsonb);
            v_payload := COALESCE(v_action->'arguments'->'payload', '{}'::jsonb);

            v_metadata := jsonb_strip_nulls(jsonb_build_object(
                'provider_id', v_provider_id,
                'method', v_method,
                'url', v_url,
                'headers', v_headers,
                'payload', v_payload,
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

        -- start_workflow -> start_workflow
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

        -- Unknown handlers are skipped
        v_results := v_results || jsonb_build_array(
            jsonb_build_object(
                'handler_key', v_handler_key,
                'status', 'skipped',
                'reason', 'handler_not_supported'
            )
        );
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM workflow_run_steps WHERE workflow_run_id = v_run_id
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
    IS 'Transforms workflow follow-up action definitions (including geocode_enrich) into workflow runs/steps and returns execution metadata.';

COMMIT;



