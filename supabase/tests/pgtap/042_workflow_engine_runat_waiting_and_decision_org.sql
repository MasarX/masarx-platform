-- pgTAP: Workflow engine schedule gating + decision attribution
-- - progress_workflow_run must respect workflow_run_steps.run_at (no early execution)
-- - record_workflow_decision must attribute decisions to the correct tenant/org

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SET search_path TO extensions, public, pg_temp;

DROP TABLE IF EXISTS tmp_workflow_engine_runat_guard;

CREATE TEMP TABLE tmp_workflow_engine_runat_guard (
    waiting_status TEXT,
    waiting_next_run_at TIMESTAMPTZ,
    waiting_workflow_status TEXT,
    decision_org UUID,
    expected_org UUID,
    decision_corr UUID,
    expected_corr UUID
) ON COMMIT DROP;

SELECT plan(5);

DO $block$
DECLARE
    v_template_id UUID := gen_random_uuid();
    v_step_id UUID := gen_random_uuid();
    v_run_id UUID;
    v_progress JSONB;
    v_wait_status TEXT;
    v_wait_next TIMESTAMPTZ;
    v_wait_run_status TEXT;

    v_org UUID;
    v_client UUID;
    v_corr UUID := gen_random_uuid();
    v_template2 UUID := gen_random_uuid();
    v_step2 UUID := gen_random_uuid();
    v_run2 UUID;
    v_decision_id UUID;
    v_decision_org UUID;
    v_decision_corr UUID;
    v_sender UUID;
BEGIN
    ---------------------------------------------------------------------------
    -- 1) run_at gating: when the only pending step is scheduled in the future,
    --    progress_workflow_run must return waiting (not execute the step).
    ---------------------------------------------------------------------------

    INSERT INTO workflow_templates (
        id, name, description, version, status, scope_type, scope_id, created_at, updated_at
    ) VALUES (
        v_template_id,
        'pgtap-runat-waiting-' || replace(gen_random_uuid()::text, '-', ''),
        'pgTAP run_at waiting guard',
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
        v_step_id,
        v_template_id,
        0,
        'record_workflow_completion',
        'workflow',
        'always',
        jsonb_build_object('status', 'completed'),
        'workflow_control',
        'v1',
        TRUE,
        now(),
        now()
    );

    v_run_id := start_workflow_run(v_template_id, '{}'::jsonb);

    UPDATE workflow_run_steps
       SET run_at = now() + interval '1 hour'
     WHERE workflow_run_id = v_run_id;

    v_progress := progress_workflow_run(v_run_id);
    v_wait_status := v_progress->>'status';
    v_wait_next := NULLIF(v_progress->>'next_run_at', '')::timestamptz;

    SELECT workflow_status
      INTO v_wait_run_status
      FROM workflow_runs
     WHERE id = v_run_id;

    ---------------------------------------------------------------------------
    -- 2) Decision attribution: record_workflow_decision must use the org_id from
    --    workflow context (and correlation from request context when set).
    ---------------------------------------------------------------------------

    PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

    INSERT INTO organizations (name, slug)
    VALUES (
        'pgTAP Workflow Org',
        'pgtap-workflow-org-' || substring(replace(gen_random_uuid()::text, '-', '') FROM 1 FOR 12)
    )
    RETURNING id INTO v_org;

    PERFORM set_config('app.organization_onboarding_source', '', true);

    INSERT INTO clients (organization_id, name, slug)
    VALUES (
        v_org,
        'pgTAP Workflow Client',
        'pgtap-workflow-client-' || substring(replace(gen_random_uuid()::text, '-', '') FROM 1 FOR 12)
    )
    RETURNING id INTO v_client;

    INSERT INTO senders (client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
    VALUES (
        v_client,
        'pgTAP Workflow Sender',
        'pgTAP Workflow Sender',
        FALSE,
        TRUE,
        'active',
        '{}'::jsonb
    )
    RETURNING id INTO v_sender;

    PERFORM bootstrap_tenant_onboarding_v1(
        v_org,
        'pgtap:workflow-engine-runat-decision-org-fixture-bootstrap'
    );

    PERFORM set_config('request.correlation_id', v_corr::text, true);

    INSERT INTO workflow_templates (
        id, name, description, version, status, scope_type, scope_id, created_at, updated_at
    ) VALUES (
        v_template2,
        'pgtap-decision-org-' || replace(gen_random_uuid()::text, '-', ''),
        'pgTAP decision attribution guard',
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
        v_step2,
        v_template2,
        0,
        'record_workflow_completion',
        'workflow',
        'always',
        jsonb_build_object('status', 'completed'),
        'workflow_control',
        'v1',
        TRUE,
        now(),
        now()
    );

    v_run2 := start_workflow_run(
        v_template2,
        jsonb_build_object(
            'organization_id', v_org,
            'client_id', v_client
        )
    );

    PERFORM progress_workflow_run(v_run2);

    SELECT decision_log_id
      INTO v_decision_id
      FROM workflow_run_steps
     WHERE workflow_run_id = v_run2
     ORDER BY sequence_order
     LIMIT 1;

    SELECT organization_id, correlation_id
      INTO v_decision_org, v_decision_corr
      FROM decision_log
     WHERE id = v_decision_id;

    INSERT INTO tmp_workflow_engine_runat_guard (
        waiting_status,
        waiting_next_run_at,
        waiting_workflow_status,
        decision_org,
        expected_org,
        decision_corr,
        expected_corr
    ) VALUES (
        v_wait_status,
        v_wait_next,
        v_wait_run_status,
        v_decision_org,
        v_org,
        v_decision_corr,
        v_corr
    );
END;
$block$;

SET LOCAL search_path TO extensions, public, pg_temp;

SELECT extensions.is(
    waiting_status,
    'waiting',
    'progress_workflow_run returns waiting when only pending step is scheduled in the future'
)
FROM tmp_workflow_engine_runat_guard;

SELECT extensions.ok(
    waiting_next_run_at > now(),
    'waiting includes next_run_at in the future'
)
FROM tmp_workflow_engine_runat_guard;

SELECT extensions.is(
    waiting_workflow_status,
    'pending',
    'workflow_run remains pending while waiting for run_at'
)
FROM tmp_workflow_engine_runat_guard;

SELECT extensions.is(
    decision_org,
    expected_org,
    'record_workflow_decision attributes decisions to workflow context organization_id'
)
FROM tmp_workflow_engine_runat_guard;

SELECT extensions.is(
    decision_corr,
    expected_corr,
    'record_workflow_decision uses request correlation_id when set'
)
FROM tmp_workflow_engine_runat_guard;

SELECT * FROM finish();

ROLLBACK;

