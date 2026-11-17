-- Migration: log_decision overload hardening (avoid named-arg ambiguity)
-- Purpose:
--   - The repo now has a new 11-arg log_decision(..., settings_resolution_id) for provenance linkage.
--   - The legacy 10-arg log_decision has trailing-arg defaults, making some named-arg calls
--     ambiguous between the 10-arg and 11-arg overloads when decision_reason is omitted.
--   - Fix by updating call sites to always pass p_decision_reason (NULL allowed) unless explicitly
--     using the new overload with p_settings_resolution_id.
--   - Apply least-privilege grants for the new overload (match existing edge_webhook_role pattern).
-- Date: 2025-12-14

BEGIN;

-- Least privilege: new overload should not be PUBLIC-executable by default.
REVOKE EXECUTE ON FUNCTION public.log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT, UUID) TO edge_webhook_role;

-- Fix named-arg ambiguity in legacy functions: ensure decision_reason is explicitly provided
-- when calling the legacy overload (NULL is acceptable).
SET search_path TO public;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_payload JSONB := CASE
        WHEN jsonb_typeof(v_ctx->'payload') = 'object' THEN COALESCE(v_ctx->'payload', '{}'::jsonb)
        ELSE '{}'::jsonb
    END;
    v_org UUID := NULLIF(v_ctx->>'organization_id', '')::UUID;
    v_client UUID := NULLIF(v_ctx->>'client_id', '')::UUID;
    v_sender UUID := NULLIF(v_ctx->>'sender_id', '')::UUID;
    v_address UUID := NULLIF(v_ctx->>'address_id', '')::UUID;
    v_shipment UUID := NULLIF(v_ctx->>'shipment_id', '')::UUID;
    v_task_type TEXT := COALESCE(NULLIF(p_step.metadata->>'task_type', ''), 'geocoding');
    v_reason TEXT := COALESCE(NULLIF(p_step.metadata->>'reason', ''), p_operation_result->>'reason');
    v_queue TEXT := NULLIF(p_step.metadata->>'queue_assignment', '');
    v_sla_minutes INT := COALESCE(NULLIF(p_step.metadata->>'sla_minutes', '')::INT, NULLIF(v_ctx->>'sla_minutes', '')::INT);
    v_due_at TIMESTAMPTZ := CASE WHEN v_sla_minutes IS NOT NULL THEN now() + make_interval(mins => v_sla_minutes) ELSE NULL END;
    v_task_id UUID := gen_random_uuid();
    v_resp workflow_handler_response;
BEGIN
    IF v_org IS NULL THEN
        v_org := NULLIF(v_payload->>'organization_id', '')::UUID;
    END IF;
    IF v_client IS NULL THEN
        v_client := NULLIF(v_payload->>'client_id', '')::UUID;
    END IF;
    IF v_sender IS NULL THEN
        v_sender := NULLIF(v_payload->>'sender_id', '')::UUID;
    END IF;
    IF v_address IS NULL THEN
        v_address := NULLIF(v_payload->>'address_id', '')::UUID;
    END IF;
    IF v_shipment IS NULL THEN
        v_shipment := NULLIF(v_payload->>'shipment_id', '')::UUID;
        IF v_shipment IS NULL AND v_payload ? 'resource_type' AND v_payload->>'resource_type' = 'shipment' THEN
            v_shipment := NULLIF(v_payload->>'resource_id', '')::UUID;
        END IF;
    END IF;
    IF v_shipment IS NULL AND v_ctx ? 'resource_type' AND v_ctx->>'resource_type' = 'shipment' THEN
        v_shipment := NULLIF(v_ctx->>'resource_id', '')::UUID;
    END IF;

    IF v_org IS NULL THEN
        v_org := current_user_org_id();
    END IF;

    INSERT INTO manual_review_tasks (
        id,
        organization_id,
        client_id,
        sender_id,
        address_id,
        shipment_id,
        task_type,
        reason,
        status,
        queue_assignment,
        sla_minutes,
        sla_due_at,
        metadata
    ) VALUES (
        v_task_id,
        v_org,
        v_client,
        v_sender,
        v_address,
        v_shipment,
        v_task_type,
        v_reason,
        'pending',
        v_queue,
        v_sla_minutes,
        v_due_at,
        jsonb_strip_nulls(jsonb_build_object('workflow_run_id', p_run.id, 'step_id', p_step.id))
    );

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'manual_review',
        p_resource_type := 'manual_review_task',
        p_resource_id := v_task_id,
        p_decision_point := 'enqueue_task',
        p_decision_outcome := 'created',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object(
            'task_type', v_task_type,
            'reason', v_reason
        ),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id);
    RETURN v_resp;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_assign_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_org UUID := COALESCE(NULLIF(v_ctx->>'organization_id', '')::UUID, current_user_org_id());
    v_task_id UUID;
    v_task_id_text TEXT := COALESCE(
        p_operation_result->>'manual_review_task_id',
        p_step.operation_result->>'manual_review_task_id',
        v_ctx->>'manual_review_task_id'
    );
    v_assigned_to UUID;
    v_assigned_to_text TEXT := COALESCE(p_operation_result->>'assigned_to', p_step.metadata->>'assigned_to');
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id_text IS NOT NULL AND btrim(v_task_id_text) <> '' THEN
        v_task_id := v_task_id_text::UUID;
    END IF;
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'manual_review_assign: manual_review_task_id missing';
    END IF;

    IF v_assigned_to_text IS NOT NULL AND btrim(v_assigned_to_text) <> '' THEN
        v_assigned_to := v_assigned_to_text::UUID;
    ELSE
        v_assigned_to := NULL;
    END IF;

    UPDATE manual_review_tasks
    SET status = 'assigned',
        assigned_to = v_assigned_to,
        updated_at = now()
    WHERE id = v_task_id;

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'manual_review',
        p_resource_type := 'manual_review_task',
        p_resource_id := v_task_id,
        p_decision_point := 'assign_task',
        p_decision_outcome := 'assigned',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('assigned_to', v_assigned_to),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id, 'assigned_to', v_assigned_to);
    RETURN v_resp;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_resolve_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_org UUID := COALESCE(NULLIF(v_ctx->>'organization_id', '')::UUID, current_user_org_id());
    v_task_id UUID;
    v_task_id_text TEXT := COALESCE(
        p_operation_result->>'manual_review_task_id',
        p_step.operation_result->>'manual_review_task_id',
        v_ctx->>'manual_review_task_id'
    );
    v_resolution TEXT := COALESCE(NULLIF(p_operation_result->>'resolution_notes', ''), p_step.metadata->>'resolution_notes');
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id_text IS NOT NULL AND btrim(v_task_id_text) <> '' THEN
        v_task_id := v_task_id_text::UUID;
    END IF;
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'manual_review_resolve: manual_review_task_id missing';
    END IF;

    UPDATE manual_review_tasks
    SET status = 'resolved',
        resolution_notes = COALESCE(v_resolution, resolution_notes),
        resolved_at = now(),
        updated_at = now()
    WHERE id = v_task_id;

    PERFORM log_decision(
        p_organization_id := v_org,
        p_decision_category := 'manual_review',
        p_resource_type := 'manual_review_task',
        p_resource_id := v_task_id,
        p_decision_point := 'resolve_task',
        p_decision_outcome := 'resolved',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object('resolution_notes', v_resolution),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id, 'resolution_notes', v_resolution);
    RETURN v_resp;
END;
$$;

CREATE OR REPLACE FUNCTION run_domain_events_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_event RECORD;
    v_policy JSONB;
    v_template UUID;
    v_context_patch JSONB;
    v_workflow_context JSONB;
    v_run UUID;
    v_org UUID;
    v_resolved_org UUID;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('domain_events_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('domain_events_worker');

    FOR v_event IN
        SELECT *
        FROM domain_events
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT v_throttle.batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            v_org := v_event.organization_id;

            IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
                v_resolved_org := NULL;

                IF v_event.resource_type IS NOT NULL AND v_event.resource_id IS NOT NULL THEN
                    BEGIN
                        v_resolved_org := resolve_organization_id_strict(v_event.resource_type, v_event.resource_id);
                    EXCEPTION
                        WHEN others THEN
                            v_resolved_org := NULL;
                    END;
                END IF;

                IF v_resolved_org IS NULL THEN
                    UPDATE domain_events
                    SET status = 'failed',
                        error_reason = 'organization_not_found',
                        processed_at = now(),
                        updated_at = now()
                    WHERE id = v_event.id;

                    CONTINUE;
                END IF;

                UPDATE domain_events
                SET organization_id = v_resolved_org,
                    updated_at = now()
                WHERE id = v_event.id;

                v_org := v_resolved_org;
                v_event.organization_id := v_resolved_org;
            END IF;

            v_policy := resolve_domain_event_policy(v_org, v_event.event_type);
            v_template := NULLIF(v_policy->>'workflow_template_id', '')::UUID;
            v_context_patch := COALESCE(v_policy->'context_patch', '{}'::jsonb);

            IF v_template IS NULL THEN
                UPDATE domain_events
                SET status = 'skipped',
                    error_reason = 'policy_not_found',
                    processed_at = now(),
                    updated_at = now()
                WHERE id = v_event.id;

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'domain_event',
                    p_resource_type := 'domain_event',
                    p_resource_id := v_event.id,
                    p_decision_point := 'dispatch',
                    p_decision_outcome := 'skipped',
                    p_performed_by_system := 'domain_events_worker',
                    p_correlation_id := v_event.correlation_id,
                    p_decision_inputs := jsonb_build_object(
                        'event_type', v_event.event_type,
                        'resource_type', v_event.resource_type,
                        'resource_id', v_event.resource_id,
                        'reason', 'policy_not_found'
                    ),
                    p_decision_reason := NULL
                );

                CONTINUE;
            END IF;

            v_workflow_context := jsonb_strip_nulls(
                jsonb_build_object(
                    'domain_event_id', v_event.id,
                    'event_type', v_event.event_type,
                    'resource_type', v_event.resource_type,
                    'resource_id', v_event.resource_id,
                    'payload', v_event.payload,
                    'trigger_source', 'domain_event',
                    'correlation_id', v_event.correlation_id
                )
            ) || jsonb_strip_nulls(COALESCE(v_context_patch, '{}'::jsonb));

            v_run := start_workflow_run(v_template, v_workflow_context);

            UPDATE domain_events
            SET status = 'processing',
                workflow_run_id = v_run,
                processed_at = now(),
                updated_at = now()
            WHERE id = v_event.id;

            PERFORM log_decision(
                p_organization_id := v_org,
                p_decision_category := 'domain_event',
                p_resource_type := 'domain_event',
                p_resource_id := v_event.id,
                p_decision_point := 'dispatch',
                p_decision_outcome := 'enqueued',
                p_performed_by_system := 'domain_events_worker',
                p_correlation_id := v_event.correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'workflow_run_id', v_run,
                    'workflow_template_id', v_template,
                    'event_type', v_event.event_type,
                    'resource_type', v_event.resource_type,
                    'resource_id', v_event.resource_id
                )),
                p_decision_reason := NULL
            );

            v_processed := v_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
                UPDATE domain_events
                SET status = 'failed',
                    error_reason = SQLERRM,
                    processed_at = now(),
                    updated_at = now()
                WHERE id = v_event.id;

                IF v_org IS NOT NULL THEN
                    PERFORM log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'domain_event',
                        p_resource_type := 'domain_event',
                        p_resource_id := v_event.id,
                        p_decision_point := 'dispatch',
                        p_decision_outcome := 'error',
                        p_performed_by_system := 'domain_events_worker',
                        p_correlation_id := v_event.correlation_id,
                        p_decision_reason := SQLERRM,
                        p_decision_inputs := jsonb_build_object(
                            'event_type', v_event.event_type,
                            'resource_type', v_event.resource_type,
                            'resource_id', v_event.resource_id
                        )
                    );
                END IF;
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_processed);
    PERFORM update_cron_config('domain_events_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_processed,
        'error_occurred', v_error
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_label_job(
    p_job_id UUID,
    p_status TEXT,
    p_file_url TEXT,
    p_file_size_bytes INTEGER,
    p_renderer_metadata JSONB DEFAULT NULL::jsonb,
    p_error_reason TEXT DEFAULT NULL::text
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_job label_jobs%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_barcode TEXT;
    v_barcode_format TEXT;
    v_label_id UUID;
    v_label_metadata JSONB;
    v_retry_seconds INTEGER;
    v_retry_length INTEGER;
    v_index INTEGER;
    v_max_delay INTEGER := 3600;
BEGIN
    SELECT *
    INTO v_job
    FROM label_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
            RAISE EXCEPTION 'Access denied for label job %', p_job_id;
        END IF;
    END IF;

    IF lower(p_status) = 'succeeded' THEN
        IF v_job.shipment_box_id IS NOT NULL THEN
            SELECT barcode
            INTO v_barcode
            FROM shipment_boxes
            WHERE id = v_job.shipment_box_id;
        END IF;

        IF v_barcode IS NULL THEN
            SELECT sb.barcode
            INTO v_barcode
            FROM shipment_boxes sb
            WHERE sb.shipment_id = v_job.shipment_id
            ORDER BY sb.box_number
            LIMIT 1;
        END IF;

        v_barcode := COALESCE(
            v_barcode,
            v_job.template_snapshot -> 'label_config' ->> 'fallback_barcode'
        );

        IF v_barcode IS NULL THEN
            RAISE EXCEPTION 'Unable to resolve barcode for label job %', p_job_id;
        END IF;

        v_barcode_format := COALESCE(
            v_job.template_snapshot -> 'label_config' ->> 'barcode_format',
            v_job.template_snapshot -> 'renderer_config' -> 'barcode' ->> 'type',
            'CODE128'
        );

        v_label_id := COALESCE(v_job.label_id, gen_random_uuid());

        v_label_metadata := jsonb_build_object(
            'label_job_id', v_job.id,
            'template', v_job.template_snapshot
        );

        -- Idempotent upsert on (barcode, shipment_id): reuse/update existing labels
        INSERT INTO labels (
            id,
            shipment_id,
            organization_id,
            client_id,
            label_type,
            barcode,
            barcode_format,
            layout_template_id,
            file_url,
            file_size_bytes,
            generated_by,
            generated_at,
            print_count,
            last_printed_at,
            metadata,
            renderer_metadata
        )
        VALUES (
            v_label_id,
            v_job.shipment_id,
            v_job.organization_id,
            v_job.client_id,
            v_job.label_type,
            v_barcode,
            v_barcode_format,
            v_job.template_id,
            p_file_url,
            COALESCE(p_file_size_bytes, 0),
            v_job.requested_by,
            v_now,
            1,
            v_now,
            v_label_metadata,
            COALESCE(p_renderer_metadata, '{}'::jsonb)
        )
        ON CONFLICT ON CONSTRAINT labels_barcode_shipment_id_key DO UPDATE
        SET file_url = EXCLUDED.file_url,
            file_size_bytes = EXCLUDED.file_size_bytes,
            generated_by = EXCLUDED.generated_by,
            generated_at = EXCLUDED.generated_at,
            last_printed_at = EXCLUDED.last_printed_at,
            print_count = labels.print_count + 1,
            label_type = EXCLUDED.label_type,
            layout_template_id = EXCLUDED.layout_template_id,
            barcode_format = EXCLUDED.barcode_format,
            metadata = EXCLUDED.metadata,
            renderer_metadata = EXCLUDED.renderer_metadata
        RETURNING id INTO v_label_id;

        UPDATE label_jobs
        SET status = 'succeeded',
            completed_at = v_now,
            lease_expires_at = NULL,
            output_file_url = p_file_url,
            output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
            renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
            error_reason = NULL,
            label_id = v_label_id
        WHERE id = v_job.id;

        INSERT INTO shipment_actions (
            id,
            shipment_id,
            organization_id,
            client_id,
            action_type,
            action_category,
            action_data,
            timestamp,
            created_at,
            performed_by_system
        )
        VALUES (
            gen_random_uuid(),
            v_job.shipment_id,
            v_job.organization_id,
            v_job.client_id,
            'label_generated',
            'operational',
            jsonb_build_object(
                'label_job_id', v_job.id,
                'label_id', v_label_id,
                'attempts', v_job.attempts,
                'template_version', v_job.template_version
            ),
            v_now,
            v_now,
            'label_renderer'
        );

        PERFORM log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_job',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'complete_label_job',
            p_decision_outcome := 'render_succeeded',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_build_object(
                'label_id', v_label_id,
                'file_url', p_file_url,
                'file_size_bytes', COALESCE(p_file_size_bytes, 0),
                'attempts', v_job.attempts + 1,
                'template_id', v_job.template_id,
                'template_version', v_job.template_version
            ),
            p_decision_reason := NULL
        );
    ELSE
        v_retry_length := COALESCE(jsonb_array_length(v_job.retry_state), 0);
        IF v_retry_length >= v_job.attempts AND v_job.attempts > 0 THEN
            v_index := v_job.attempts;
            v_retry_seconds := COALESCE((v_job.retry_state ->> (v_index - 1))::INTEGER, 0);
        ELSE
            v_retry_seconds := 0;
        END IF;
        IF v_retry_seconds <= 0 THEN
            v_retry_seconds := LEAST(v_max_delay, 60 * (2 ^ GREATEST(v_job.attempts - 1, 0)));
        END IF;
        v_retry_seconds := LEAST(v_max_delay, GREATEST(v_retry_seconds, 30));

        IF v_job.attempts >= v_job.max_attempts THEN
            UPDATE label_jobs
            SET status = 'failed',
                completed_at = v_now,
                lease_expires_at = NULL,
                renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
                error_reason = COALESCE(p_error_reason, 'max_attempts_exceeded')
            WHERE id = v_job.id;

            PERFORM log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_failed',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := NULL,
                p_decision_inputs := jsonb_build_object(
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version
                ),
                p_decision_reason := COALESCE(p_error_reason, 'max_attempts_exceeded')
            );
        ELSE
            UPDATE label_jobs
            SET status = 'pending',
                lease_expires_at = NULL,
                scheduled_at = v_now + make_interval(secs => v_retry_seconds),
                renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
                error_reason = p_error_reason
            WHERE id = v_job.id;

            PERFORM log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_retry_scheduled',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := NULL,
                p_decision_inputs := jsonb_build_object(
                    'next_attempt_in_seconds', v_retry_seconds,
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version
                ),
                p_decision_reason := p_error_reason
            );
        END IF;
    END IF;
END;
$function$;

COMMIT;
