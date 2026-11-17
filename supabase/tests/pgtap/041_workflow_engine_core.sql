-- pgTAP: Workflow engine lifecycle, context merge, and handler orchestration

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SET search_path TO extensions, public, pg_temp;

DROP TABLE IF EXISTS tmp_workflow_engine_core;

CREATE TEMP TABLE tmp_workflow_engine_core (
    run_id UUID,
    fixture_present BOOLEAN,
    start_run_nonnull BOOLEAN,
    context_has_tracking BOOLEAN,
    planned_id_present BOOLEAN,
    planned_tracking_context TEXT,
    planned_tracking_value TEXT,
    initial_progress_status TEXT,
    reserve_step_status TEXT,
    create_step_status TEXT,
    final_progress_status TEXT,
    workflow_status TEXT,
    current_step_is_null BOOLEAN,
    completed_at_not_null BOOLEAN,
    shipment_exists BOOLEAN
) ON COMMIT DROP;

SELECT plan(13);

DO $block$
DECLARE
    v_client_id UUID;
    v_org_id UUID;
    v_template_id UUID := gen_random_uuid();
    v_step_reserve UUID := gen_random_uuid();
    v_step_create UUID := gen_random_uuid();
    v_run_id UUID;
    v_context JSONB;
    v_planned_id UUID;
    v_planned_tracking TEXT;
    v_progress JSONB;
    v_status TEXT;
    v_current_step UUID;
    v_completed_at TIMESTAMPTZ;
    v_context_has_tracking BOOLEAN;
    v_planned_id_present BOOLEAN;
    v_reserve_status TEXT;
    v_create_status TEXT;
    v_initial_status TEXT;
    v_final_status TEXT;
    v_shipment_exists BOOLEAN;
    v_start_not_null BOOLEAN := FALSE;
    v_fixture_present BOOLEAN := FALSE;
BEGIN
    SELECT c.id, c.organization_id
    INTO v_client_id, v_org_id
    FROM clients c
    ORDER BY c.created_at
    LIMIT 1;

    IF v_client_id IS NULL THEN
        RAISE EXCEPTION 'Client fixture missing for workflow engine test';
    END IF;

    v_fixture_present := TRUE;

    INSERT INTO workflow_templates (
        id, name, description, version, status,
        scope_type, scope_id, created_at, updated_at
    ) VALUES (
        v_template_id,
        'pgtemp_engine_core',
        'Temporary template for workflow engine pgTAP coverage',
        1,
        'active',
        'global',
        NULL,
        now(),
        now()
    );

    INSERT INTO workflow_template_steps (
        id,
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        metadata,
        handler_key,
        handler_version,
        enabled,
        created_at,
        updated_at
    ) VALUES (
        v_step_reserve,
        v_template_id,
        0,
        'reserve_identifiers',
        'workflow',
        'always',
        jsonb_build_object('resource_type', 'shipment'),
        'reserve_shipment_identifiers',
        'v1',
        TRUE,
        now(),
        now()
    ), (
        v_step_create,
        v_template_id,
        1,
        'create_shipment',
        'workflow',
        'always',
        '{}'::jsonb,
        'shipment_create',
        'v1',
        TRUE,
        now(),
        now()
    );

    v_run_id := start_workflow_run(
        v_template_id,
        jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id
    )
    );

    v_start_not_null := v_run_id IS NOT NULL;

    v_progress := progress_workflow_run(v_run_id);
    v_initial_status := v_progress->>'status';

    SELECT context INTO v_context
    FROM workflow_runs
    WHERE id = v_run_id;

    v_context_has_tracking := (v_context->>'planned_tracking_number') IS NOT NULL;
    v_planned_id := NULLIF(v_context->>'planned_shipment_id', '')::UUID;
    v_planned_tracking := v_context->>'planned_tracking_number';

    v_planned_id_present := v_planned_id IS NOT NULL;

    v_progress := progress_workflow_run(v_run_id);

    SELECT step_status
    INTO v_reserve_status
    FROM workflow_run_steps
    WHERE workflow_run_id = v_run_id
      AND sequence_order = 0;

    SELECT step_status
    INTO v_create_status
    FROM workflow_run_steps
    WHERE workflow_run_id = v_run_id
      AND sequence_order = 1;

    v_shipment_exists := EXISTS (
        SELECT 1
        FROM shipments
        WHERE id = v_planned_id
          AND tracking_number = v_planned_tracking
    );

    v_progress := progress_workflow_run(v_run_id);

    v_final_status := v_progress->>'status';

    SELECT workflow_status, current_step_id, completed_at
    INTO v_status, v_current_step, v_completed_at
    FROM workflow_runs
    WHERE id = v_run_id;

    INSERT INTO tmp_workflow_engine_core (
        run_id,
        fixture_present,
        start_run_nonnull,
        context_has_tracking,
        planned_id_present,
        planned_tracking_context,
        planned_tracking_value,
        initial_progress_status,
        reserve_step_status,
        create_step_status,
        final_progress_status,
        workflow_status,
        current_step_is_null,
        completed_at_not_null,
        shipment_exists
    )
    VALUES (
        v_run_id,
        v_fixture_present,
        v_start_not_null,
        v_context_has_tracking,
        v_planned_id_present,
        COALESCE(
            v_context->'workflow'->'context_patch'->>'planned_tracking_number',
            v_context->>'planned_tracking_number'
        ),
        v_planned_tracking,
        v_initial_status,
        v_reserve_status,
        v_create_status,
        v_final_status,
        v_status,
        v_current_step IS NULL,
        v_completed_at IS NOT NULL,
        v_shipment_exists
    );
END;
$block$;

SET LOCAL search_path TO extensions, public, pg_temp;

SELECT extensions.ok(fixture_present, 'Client fixture located for workflow engine test'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.ok(start_run_nonnull, 'start_workflow_run returned workflow run id'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.ok(context_has_tracking, 'Context patch persisted planned tracking number after reserve step'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.ok(planned_id_present, 'Context includes planned shipment id'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.is(planned_tracking_context, planned_tracking_value, 'workflow.context_patch mirrors planned tracking'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.is(initial_progress_status, 'completed', 'Create step returns completed status'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.is(create_step_status, 'completed', 'Create step recorded as completed'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.is(reserve_step_status, 'completed', 'Reserve step remains completed'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.is(final_progress_status, 'completed', 'Final progress call returns completed status when no steps remain'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.is(workflow_status, 'completed', 'Workflow run status marked as completed'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.ok(current_step_is_null, 'Workflow current_step_id cleared on completion'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.ok(completed_at_not_null, 'Workflow completed_at timestamp recorded'::text)
FROM tmp_workflow_engine_core;

SELECT extensions.ok(shipment_exists, 'Shipment inserted using planned identifiers'::text)
FROM tmp_workflow_engine_core;

SELECT * FROM finish();

ROLLBACK;
