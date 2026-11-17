-- pgTAP: Workflow guardrails enforcement

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM workflow_guardrails
        WHERE resource_table = 'workflow_runs'
          AND enforcement_mode = 'enforce'
    ),
    'workflow_runs guardrail row exists'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM workflow_guardrails
        WHERE resource_table = 'workflow_run_steps'
          AND enforcement_mode = 'enforce'
    ),
    'workflow_run_steps guardrail row exists'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM workflow_guardrails
        WHERE resource_table = 'outbound_calls'
          AND enforcement_mode = 'enforce'
    ),
    'outbound_calls guardrail row exists'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM workflow_guardrails
        WHERE resource_table = 'label_jobs'
          AND enforcement_mode = 'enforce'
    ),
    'label_jobs guardrail row exists'
);

SELECT ok(
    (
        SELECT required_context_keys @> ARRAY['workflow_run_id','workflow_run_step_id']::TEXT[]
        FROM workflow_guardrails
        WHERE resource_table = 'label_jobs'
    ),
    'label_jobs guardrail requires workflow_run_id + workflow_run_step_id'
);

SELECT ok(
    (
        SELECT context_match ? 'workflow_run_step_id'
        FROM workflow_guardrails
        WHERE resource_table = 'label_jobs'
    ),
    'label_jobs guardrail maps workflow_run_step_id context to column'
);

SELECT throws_ok($$
    DO $do$
    DECLARE
        v_template_id UUID := gen_random_uuid();
        v_step_id UUID := gen_random_uuid();
        v_run_id UUID := gen_random_uuid();
    BEGIN
        INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
        VALUES (v_template_id, 'pgtap_guardrails_template', 'temp', 1, 'active', 'global');

        INSERT INTO workflow_template_steps (
            id, workflow_template_id, sequence_order, operation_name,
            transition_condition, handler_key, handler_version, enabled
        )
        VALUES (
            v_step_id, v_template_id, 1, 'workflow_control',
            'always', 'workflow_control', 'v1', TRUE
        );

        INSERT INTO workflow_runs (
            id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context
        )
        VALUES (
            v_run_id, v_template_id, 1, 'test', 'pending', '{}'::jsonb
        );
    END
    $do$;
$$, 'P0001', 'workflow guardrails: missing context workflow_run_id for public.workflow_runs');

SELECT lives_ok($$
    DO $do$
    DECLARE
        v_template_id UUID := gen_random_uuid();
        v_step_id UUID := gen_random_uuid();
        v_run_id UUID := gen_random_uuid();
    BEGIN
        INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
        VALUES (v_template_id, 'pgtap_guardrails_template_ok', 'temp', 1, 'active', 'global');

        INSERT INTO workflow_template_steps (
            id, workflow_template_id, sequence_order, operation_name,
            transition_condition, handler_key, handler_version, enabled
        )
        VALUES (
            v_step_id, v_template_id, 1, 'workflow_control',
            'always', 'workflow_control', 'v1', TRUE
        );

        PERFORM set_config('app.workflow_run_id', v_run_id::text, true);

        INSERT INTO workflow_runs (
            id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context
        )
        VALUES (
            v_run_id, v_template_id, 1, 'test', 'pending', '{}'::jsonb
        );
    END
    $do$;
$$, 'workflow_runs insert allowed with context');

SELECT throws_ok($$
    DO $do$
    DECLARE
        v_template_id UUID := gen_random_uuid();
        v_step_tpl_id UUID := gen_random_uuid();
        v_run_id UUID := gen_random_uuid();
        v_step_id UUID := gen_random_uuid();
    BEGIN
        INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
        VALUES (v_template_id, 'pgtap_guardrails_steps', 'temp', 1, 'active', 'global');

        INSERT INTO workflow_template_steps (
            id, workflow_template_id, sequence_order, operation_name,
            transition_condition, handler_key, handler_version, enabled
        )
        VALUES (
            v_step_tpl_id, v_template_id, 1, 'workflow_control',
            'always', 'workflow_control', 'v1', TRUE
        );

        PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
        INSERT INTO workflow_runs (
            id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context
        )
        VALUES (
            v_run_id, v_template_id, 1, 'test', 'pending', '{}'::jsonb
        );

        PERFORM set_config('app.workflow_run_id', '', true);
        INSERT INTO workflow_run_steps (
            id, workflow_run_id, workflow_template_step_id, sequence_order,
            step_status, operation_name, handler_key, handler_version,
            max_retries, enqueued_at, created_at, updated_at
        )
        VALUES (
            v_step_id, v_run_id, v_step_tpl_id, 1,
            'pending', 'workflow_control', 'workflow_control', 'v1',
            1, now(), now(), now()
        );
    END
    $do$;
$$, 'P0001', 'workflow guardrails: missing context workflow_run_id for public.workflow_run_steps');

SELECT lives_ok($$
    DO $do$
    DECLARE
        v_template_id UUID := gen_random_uuid();
        v_step_tpl_id UUID := gen_random_uuid();
        v_run_id UUID := gen_random_uuid();
        v_step_id UUID := gen_random_uuid();
    BEGIN
        INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
        VALUES (v_template_id, 'pgtap_guardrails_steps_ok', 'temp', 1, 'active', 'global');

        INSERT INTO workflow_template_steps (
            id, workflow_template_id, sequence_order, operation_name,
            transition_condition, handler_key, handler_version, enabled
        )
        VALUES (
            v_step_tpl_id, v_template_id, 1, 'workflow_control',
            'always', 'workflow_control', 'v1', TRUE
        );

        PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
        INSERT INTO workflow_runs (
            id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context
        )
        VALUES (
            v_run_id, v_template_id, 1, 'test', 'pending', '{}'::jsonb
        );

        PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
        INSERT INTO workflow_run_steps (
            id, workflow_run_id, workflow_template_step_id, sequence_order,
            step_status, operation_name, handler_key, handler_version,
            max_retries, enqueued_at, created_at, updated_at
        )
        VALUES (
            v_step_id, v_run_id, v_step_tpl_id, 1,
            'pending', 'workflow_control', 'workflow_control', 'v1',
            1, now(), now(), now()
        );
    END
    $do$;
$$, 'workflow_run_steps insert allowed with context');

SELECT finish();

ROLLBACK;
