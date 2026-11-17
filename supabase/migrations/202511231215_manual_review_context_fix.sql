-- Purpose: Ensure manual review handler lifts organization context from nested payloads.
-- Date: 2025-11-23

BEGIN;

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
        )
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
        p_decision_inputs := jsonb_build_object('assigned_to', v_assigned_to)
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
        p_decision_inputs := jsonb_build_object('resolution_notes', v_resolution)
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id, 'resolution_notes', v_resolution);
    RETURN v_resp;
END;
$$;

COMMIT;
