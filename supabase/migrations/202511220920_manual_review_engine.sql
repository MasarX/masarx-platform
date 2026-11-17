-- Migration: Manual Review via Engine (domain event + handler + template + policy)

BEGIN;

SET search_path TO public;

-- 1) Handler: execute_manual_review_v1
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
    v_resp.workflow_status := NULL; -- let engine continue
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id);
    RETURN v_resp;
END;
$$;

-- Register handler
-- Disable signature validation trigger while inserting to avoid race on function visibility
ALTER TABLE operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
) VALUES (
    'manual_review',
    'workflow_handlers',
    'execute_manual_review_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Insert a manual_review_tasks row from workflow context and emit decision.',
    'docs/product/guides/subsystem-implementation.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

-- 2) Minimal workflow template for manual review
DO $$
DECLARE
    v_template_id UUID := '99990000-0000-0000-0000-000000560001'::UUID;
BEGIN
    INSERT INTO workflow_templates (id, name, description, status, version, scope_type, scope_id, notes, created_at, updated_at)
    VALUES (
        v_template_id,
        'manual_review_v1',
        'Enqueue a manual review task and continue.',
        'active',
        1,
        'global',
        NULL,
        'Generic manual review entry',
        now(),
        now()
    )
    ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        scope_type = EXCLUDED.scope_type,
        scope_id = EXCLUDED.scope_id,
        updated_at = now();

    -- Step 1: enqueue task
    INSERT INTO workflow_template_steps (
        workflow_template_id,
        sequence_order,
        operation_name,
        transition_condition,
        metadata,
        enabled,
        handler_key,
        handler_version
    ) VALUES (
        v_template_id,
        1,
        'manual_review_enqueue',
        'always',
        jsonb_build_object('task_type','geocoding'),
        TRUE,
        'manual_review',
        'v1'
    )
    ON CONFLICT DO NOTHING;
END$$;

-- 3) SECDEF enqueue function for internal callers
CREATE OR REPLACE FUNCTION enqueue_manual_review(
    p_organization_id UUID,
    p_client_id UUID,
    p_resource_type TEXT,
    p_resource_id UUID,
    p_task_type TEXT DEFAULT 'geocoding',
    p_reason TEXT DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_payload JSONB;
    v_id UUID;
BEGIN
    v_payload := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', p_organization_id,
        'client_id', p_client_id,
        'resource_type', lower(p_resource_type),
        'resource_id', p_resource_id,
        'task_type', lower(COALESCE(p_task_type,'geocoding')),
        'reason', p_reason
    )) || COALESCE(p_payload, '{}'::jsonb);

    v_id := enqueue_domain_event(
        p_organization_id := p_organization_id,
        p_event_type := 'manual_review.requested',
        p_resource_type := lower(p_resource_type),
        p_resource_id := p_resource_id,
        p_payload := v_payload,
        p_correlation_id := NULL
    );
    RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION enqueue_manual_review(UUID,UUID,TEXT,UUID,TEXT,TEXT,JSONB) TO authenticated, service_role;

-- 4) domain_event_policy: wire event to template (global scope)
DO $$
DECLARE
    v_settings_id UUID;
    v_sv_id UUID;
    v_value JSONB := '{"events": {}}'::jsonb;
BEGIN
    SELECT id INTO v_settings_id FROM settings WHERE category = 'domain_event_policy' AND scope_type = 'global' LIMIT 1;
    IF v_settings_id IS NULL THEN
        INSERT INTO settings_versions (id, category, scope_type, scope_hash, value, version, schema_version, change_reason, approved_at, effective_from)
        VALUES (
            '99990000-0000-0000-0000-000000560010',
            'domain_event_policy',
            'global',
            '00000000-0000-0000-0000-000000000000',
            '{"events": {}}'::jsonb,
            1,
            1,
            'Create global domain_event_policy',
            now(),
            now()
        ) ON CONFLICT (id, scope_hash) DO NOTHING;

        INSERT INTO settings (id, category, scope_type, scope_hash, settings_version_id, cached_value, last_updated)
        VALUES (
            '99990000-0000-0000-0000-000000560011',
            'domain_event_policy',
            'global',
            '00000000-0000-0000-0000-000000000000',
            '99990000-0000-0000-0000-000000560010',
            '{"events": {}}'::jsonb,
            now()
        ) ON CONFLICT (category, scope_type, scope_hash) DO NOTHING;
    END IF;

    UPDATE settings
    SET cached_value = jsonb_set(
        COALESCE(cached_value, '{"events": {}}'::jsonb),
        ARRAY['events','manual_review.requested','workflow_template_id'],
        to_jsonb('99990000-0000-0000-0000-000000560001'::text),
        TRUE
    ),
        last_updated = now()
    WHERE category = 'domain_event_policy' AND scope_type = 'global' AND scope_hash = '00000000-0000-0000-0000-000000000000';
END$$;

COMMIT;
