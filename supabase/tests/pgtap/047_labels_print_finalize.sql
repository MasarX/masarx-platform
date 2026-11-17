-- pgTAP: Labels print finalize invariants

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SET search_path TO extensions, public, pg_temp;

SELECT plan(5);

DO $$
DECLARE
    v_org_id UUID := gen_random_uuid();
    v_client_id UUID := gen_random_uuid();
    v_template_id UUID := gen_random_uuid();
    v_step_id UUID := gen_random_uuid();
    v_step_tpl_id UUID := gen_random_uuid();
    v_run_id UUID := gen_random_uuid();
    v_requested_by UUID := gen_random_uuid();
    v_bundle_id UUID := gen_random_uuid();
    v_file_path TEXT := NULL;
    v_result_json JSONB;
    v_status TEXT;
    v_decision_count INT := 0;
BEGIN
    INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
    VALUES (v_org_id, 'pgTAP Labels Org', 'pgtap-labels-org', 'UTC', 'en-US', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
    VALUES (v_client_id, v_org_id, 'pgTAP Labels Client', 'pgtap-labels-client', 'standard', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO workflow_templates (
        id, name, description, version, status, scope_type, scope_id, created_at, updated_at
    ) VALUES (
        v_template_id, 'pgtap_labels_finalize', 'temp template', 1, 'active', 'global', NULL, now(), now()
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO workflow_template_steps (
        id, workflow_template_id, sequence_order, operation_name, operation_settings_category,
        transition_condition, metadata, handler_key, handler_version, enabled, created_at, updated_at
    ) VALUES (
        v_step_tpl_id, v_template_id, 1, 'finalize_label_print', 'workflow', 'always', '{}'::jsonb,
        'label_print_finalize', 'v1', TRUE, now(), now()
    ) ON CONFLICT (id) DO NOTHING;

    v_file_path := format('%s/bundles/%s.pdf', v_org_id::text, v_bundle_id::text);

    PERFORM set_config('app.workflow_run_id', v_run_id::text, true);

    INSERT INTO workflow_runs (
        id, workflow_template_id, workflow_template_version, entry_point, workflow_status,
        context, metadata, created_at, updated_at
    ) VALUES (
        v_run_id, v_template_id, 1, 'test', 'in_progress',
        jsonb_build_object(
            'requested_by', v_requested_by,
            'label_print', jsonb_build_object(
                'organization_id', v_org_id,
                'ready', '[]'::jsonb,
                'counts', jsonb_build_object('requested', 1, 'ready', 1),
                'bundle_response', jsonb_build_object('status','ok','bundle_id', v_bundle_id, 'file_path', v_file_path)
            )
        ),
        '{}'::jsonb, now(), now()
    );

    INSERT INTO workflow_run_steps (
        id, workflow_run_id, workflow_template_step_id, sequence_order, step_status,
        operation_name, max_retries, metadata, handler_key, handler_version, enqueued_at, created_at, updated_at
    ) VALUES (
        v_step_id, v_run_id, v_step_tpl_id, 1, 'pending', 'finalize_label_print', 1,
        '{}'::jsonb, 'label_print_finalize', 'v1', now(), now(), now()
    );

    SELECT to_jsonb(workflow_handlers.execute_label_print_finalize_v1(wrs, wr, '{}'::jsonb))
    INTO v_result_json
    FROM workflow_run_steps wrs
    JOIN workflow_runs wr ON wr.id = wrs.workflow_run_id
    WHERE wrs.id = v_step_id;

    v_status := v_result_json->>'status';

    PERFORM is(v_status, 'completed', 'finalize handler returns completed');
    PERFORM is(v_result_json->'operation_result'->>'status', 'ok', 'operation_result signals ok status');

    PERFORM ok(
        EXISTS (
            SELECT 1
            FROM workflow_runs
            WHERE id = v_run_id
              AND COALESCE(context->'label_print', '{}'::jsonb) ? 'bundle_response'
        ),
        'workflow context retains bundle_response'
    );

    SELECT count(*) INTO v_decision_count
    FROM decision_log
    WHERE organization_id = v_org_id
      AND decision_category = 'label_print'
      AND resource_id = v_bundle_id;

    PERFORM ok(v_decision_count > 0, 'decision_log entry recorded for bundle');

    PERFORM ok(
        EXISTS (
            SELECT 1
            FROM decision_log
            WHERE organization_id = v_org_id
              AND decision_category = 'label_print'
              AND resource_id = v_bundle_id
              AND COALESCE(decision_inputs->>'file_path','') <> ''
        ),
        'decision_log contains file_path in decision_inputs'
    );
END $$;

SELECT finish();

ROLLBACK;
