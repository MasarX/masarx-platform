-- pgTAP: Workflow engine sequence gate + explicit wake
-- - Only the earliest pending step may execute.
-- - Explicit input can wake that earliest pending step before run_at.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SET search_path TO extensions, public, pg_temp;

SELECT plan(6);

DO $block$
DECLARE
    v_org UUID;
    v_client UUID;
    v_sender UUID;
    v_template_id UUID := gen_random_uuid();
    v_step_1 UUID := gen_random_uuid();
    v_step_2 UUID := gen_random_uuid();
    v_run_id UUID;
    v_wait JSONB;
    v_wake JSONB;
    v_wait_step1_status TEXT;
    v_wait_step2_status TEXT;
    v_wake_step1_status TEXT;
    v_wake_step2_status TEXT;
BEGIN
    PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

    INSERT INTO organizations (name, slug)
    VALUES (
        'pgTAP Workflow Sequence Org',
        'pgtap-sequence-org-' || substring(replace(gen_random_uuid()::text, '-', '') FROM 1 FOR 12)
    )
    RETURNING id INTO v_org;

    PERFORM set_config('app.organization_onboarding_source', '', true);

    INSERT INTO clients (organization_id, name, slug)
    VALUES (
        v_org,
        'pgTAP Workflow Sequence Client',
        'pgtap-sequence-client-' || substring(replace(gen_random_uuid()::text, '-', '') FROM 1 FOR 12)
    )
    RETURNING id INTO v_client;

    INSERT INTO senders (client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
    VALUES (
        v_client,
        'pgTAP Workflow Sequence Sender',
        'pgTAP Workflow Sequence Sender',
        FALSE,
        TRUE,
        'active',
        '{}'::jsonb
    )
    RETURNING id INTO v_sender;

    PERFORM bootstrap_tenant_onboarding_v1(
        v_org,
        'pgtap:workflow-engine-sequence-wake-fixture-bootstrap'
    );

    INSERT INTO workflow_templates (
        id, name, description, version, status, scope_type, scope_id, created_at, updated_at
    ) VALUES (
        v_template_id,
        'pgtap-sequence-wake-' || replace(gen_random_uuid()::text, '-', ''),
        'pgTAP sequence wake guard',
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
    ) VALUES
    (
        v_step_1,
        v_template_id,
        1,
        'first_step',
        'workflow',
        'always',
        jsonb_build_object('action', 'complete'),
        'workflow_control',
        'v1',
        TRUE,
        now(),
        now()
    ),
    (
        v_step_2,
        v_template_id,
        2,
        'second_step',
        'workflow',
        'always',
        jsonb_build_object('action', 'complete'),
        'workflow_control',
        'v1',
        TRUE,
        now(),
        now()
    );

    v_run_id := start_workflow_run(
        v_template_id,
        jsonb_build_object(
            'organization_id', v_org,
            'client_id', v_client
        )
    );

    UPDATE workflow_run_steps
       SET run_at = now() + interval '1 hour'
     WHERE workflow_run_id = v_run_id
       AND sequence_order = 1;

    UPDATE workflow_run_steps
       SET run_at = now()
     WHERE workflow_run_id = v_run_id
       AND sequence_order = 2;

    v_wait := public.progress_workflow_run(v_run_id);

    SELECT step_status
      INTO v_wait_step1_status
      FROM workflow_run_steps
     WHERE workflow_run_id = v_run_id
       AND sequence_order = 1;

    SELECT step_status
      INTO v_wait_step2_status
      FROM workflow_run_steps
     WHERE workflow_run_id = v_run_id
       AND sequence_order = 2;

    v_wake := public.progress_workflow_run(v_run_id, jsonb_build_object('wake_reason', 'explicit_input'));

    SELECT step_status
      INTO v_wake_step1_status
      FROM workflow_run_steps
     WHERE workflow_run_id = v_run_id
       AND sequence_order = 1;

    SELECT step_status
      INTO v_wake_step2_status
      FROM workflow_run_steps
     WHERE workflow_run_id = v_run_id
       AND sequence_order = 2;

    CREATE TEMP TABLE tmp_workflow_engine_sequence_wake ON COMMIT DROP AS
    SELECT
        v_wait->>'status' AS wait_status,
        NULLIF(v_wait->>'next_run_at', '')::timestamptz AS wait_next_run_at,
        v_wait_step1_status AS wait_step1_status,
        v_wait_step2_status AS wait_step2_status,
        v_wake->>'status' AS wake_status,
        v_wake_step1_status AS wake_step1_status,
        v_wake_step2_status AS wake_step2_status;
END;
$block$;

SELECT extensions.is(
    wait_status,
    'waiting',
    'workflow waits when the first pending step is scheduled in the future'
)
FROM tmp_workflow_engine_sequence_wake;

SELECT extensions.ok(
    wait_next_run_at > now(),
    'waiting surfaces the first pending step next_run_at'
)
FROM tmp_workflow_engine_sequence_wake;

SELECT extensions.is(
    wait_step1_status,
    'pending',
    'first pending step remains pending while waiting'
)
FROM tmp_workflow_engine_sequence_wake;

SELECT extensions.is(
    wait_step2_status,
    'pending',
    'later pending step does not overtake the first pending step'
)
FROM tmp_workflow_engine_sequence_wake;

SELECT extensions.is(
    wake_status,
    'completed',
    'explicit input wakes the first pending step immediately'
)
FROM tmp_workflow_engine_sequence_wake;

SELECT extensions.ok(
    wake_step1_status = 'completed' AND wake_step2_status = 'pending',
    'explicit wake completes only the first pending step and preserves later step ordering'
)
FROM tmp_workflow_engine_sequence_wake;

SELECT * FROM finish();

ROLLBACK;
