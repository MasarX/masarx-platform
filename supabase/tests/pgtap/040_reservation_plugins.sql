-- pgTAP: Reservation plugin scope inference and idempotent behaviours

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

DO $block$
DECLARE
    v_template_id UUID;
    v_template_step_id UUID;
    v_client_id UUID;
    v_org_id UUID;
    v_run public.workflow_runs;
    v_step public.workflow_run_steps;
    v_response public.workflow_handler_response;
    v_planned_id UUID := gen_random_uuid();
    v_planned_tracking TEXT := 'REUSE' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
BEGIN
    SELECT wt.id,
           (
             SELECT id
             FROM workflow_template_steps
             WHERE workflow_template_id = wt.id
             ORDER BY sequence_order
             LIMIT 1
           )
    INTO v_template_id, v_template_step_id
    FROM workflow_templates wt
    WHERE wt.name = 'shipment_return_v1'
    LIMIT 1;

    PERFORM ok(v_template_id IS NOT NULL, 'shipment_return_v1 template located for reservation tests');

    SELECT c.id, c.organization_id
    INTO v_client_id, v_org_id
    FROM clients c
    ORDER BY c.created_at
    LIMIT 1;

    -- 1) Auto-scope inference prefers client scope.
    v_run := jsonb_populate_record(
        NULL::public.workflow_runs,
        jsonb_build_object(
            'id', gen_random_uuid(),
            'workflow_template_id', v_template_id,
            'workflow_template_version', 1,
            'entry_point', 'webhook',
            'workflow_status', 'pending',
            'retry_count', 0,
            'version', 1,
            'created_at', now(),
            'updated_at', now(),
            'context', jsonb_build_object(
                'organization_id', v_org_id,
                'client_id', v_client_id
            )
        )
    );

    v_step := jsonb_populate_record(
        NULL::public.workflow_run_steps,
        jsonb_build_object(
            'id', gen_random_uuid(),
            'workflow_run_id', v_run.id,
            'workflow_template_step_id', v_template_step_id,
            'sequence_order', 0,
            'operation_name', 'reserve_identifiers',
            'manual_action_required', false,
            'metadata', '{}'::jsonb,
            'enabled', true,
            'handler_key', 'reserve_shipment_identifiers',
            'handler_version', 'v1',
            'step_status', 'pending',
            'retry_attempt', 0,
            'max_retries', 1,
            'created_at', now(),
            'updated_at', now(),
            'run_at', now(),
            'enqueued_at', now(),
            'runtime_state', '{}'::jsonb
        )
    );

    v_response := workflow_handlers.reserve_identifiers_v1(v_step, v_run, '{}'::jsonb);

    PERFORM is(v_response.operation_result->>'tracking_scope_type', 'client', 'Reserve handler infers client tracking scope from context');
    PERFORM is(v_response.operation_result->>'tracking_scope_id', v_client_id::text, 'Reserve handler returns client id in tracking_scope_id');

    -- 2) Metadata override honours tenant scope selection.
    v_step.metadata := jsonb_build_object(
        'resource_type', 'shipment',
        'tracking_scope_type', 'tenant',
        'tracking_scope_id', v_org_id
    );
    v_response := workflow_handlers.reserve_identifiers_v1(v_step, v_run, '{}'::jsonb);
    PERFORM is(v_response.operation_result->>'tracking_scope_type', 'tenant', 'Metadata override sets tracking scope type to tenant');
    PERFORM is(v_response.operation_result->>'tracking_scope_id', v_org_id::text, 'Metadata override returns organization id in tracking_scope_id');

    -- 3) Pre-existing planned identifiers are preserved.
    v_run.context := jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'planned_resource_id', v_planned_id,
        'planned_tracking_number', v_planned_tracking
    );
    v_step.metadata := jsonb_build_object('resource_type', 'shipment');
    v_response := workflow_handlers.reserve_identifiers_v1(v_step, v_run, '{}'::jsonb);
    PERFORM is(v_response.context_patch->>'planned_tracking_number', v_planned_tracking, 'Existing planned tracking number is reused');

    -- 4) Non-shipment resource returns only planned_resource_id.
    v_step.metadata := jsonb_build_object('resource_type', 'routing_batch');
    v_response := workflow_handlers.reserve_identifiers_v1(v_step, v_run, '{}'::jsonb);
    PERFORM ok(NOT (v_response.context_patch ? 'planned_tracking_number'), 'Non-shipment resource omits planned_tracking_number in context patch');
END;
$block$;

SELECT * FROM finish();

ROLLBACK;
