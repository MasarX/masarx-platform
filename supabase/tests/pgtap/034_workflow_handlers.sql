-- pgTAP: Validate workflow handler plugins (reserve_identifiers, context_extract_from_mapping)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

WITH reserve_result AS (
    WITH base AS (
        SELECT
            gen_random_uuid() AS run_id,
            '99990000-0000-0000-0000-000000300002'::uuid AS template_id,
            gen_random_uuid() AS org_id,
            gen_random_uuid() AS client_id,
            (SELECT id FROM workflow_template_steps WHERE workflow_template_id = '99990000-0000-0000-0000-000000300002'::uuid ORDER BY sequence_order LIMIT 1) AS template_step_id
    ),
    run_rec AS (
        SELECT jsonb_populate_record(
            NULL::public.workflow_runs,
            jsonb_build_object(
                'id', run_id,
                'workflow_template_id', template_id,
                'workflow_template_version', 1,
                'entry_point', 'webhook',
                'workflow_status', 'pending',
                'retry_count', 0,
                'version', 1,
                'created_at', now(),
                'updated_at', now(),
                'context', jsonb_build_object(
                    'organization_id', org_id,
                    'client_id', client_id
                )
            )
        ) AS run
        FROM base
    ),
    step_rec AS (
        SELECT jsonb_populate_record(
            NULL::public.workflow_run_steps,
            jsonb_build_object(
                'id', gen_random_uuid(),
                'workflow_run_id', (SELECT run_id FROM base),
                'workflow_template_step_id', (SELECT template_step_id FROM base),
                'sequence_order', 0,
                'operation_name', 'reserve_identifiers',
                'manual_action_required', false,
                'metadata', '{}'::jsonb,
                'enabled', true,
                'handler_key', 'reserve_shipment_identifiers',
                'handler_version', 'v1',
                'step_status', 'pending',
                'retry_attempt', 1,
                'max_retries', 1,
                'created_at', now(),
                'updated_at', now(),
                'run_at', now(),
                'enqueued_at', now(),
                'runtime_state', '{}'::jsonb
            )
        ) AS step
        FROM base
    )
    SELECT workflow_handlers.reserve_identifiers_v1(step_rec.step, run_rec.run, '{}'::jsonb) AS response
    FROM step_rec, run_rec
)
SELECT ok(
    ((reserve_result.response).context_patch->>'planned_tracking_number') IS NOT NULL,
    'reserve_identifiers_v1 generates planned tracking number'
)
FROM reserve_result;

WITH reserve_result AS (
    WITH base AS (
        SELECT
            gen_random_uuid() AS run_id,
            '99990000-0000-0000-0000-000000300002'::uuid AS template_id,
            gen_random_uuid() AS org_id,
            gen_random_uuid() AS client_id,
            (SELECT id FROM workflow_template_steps WHERE workflow_template_id = '99990000-0000-0000-0000-000000300002'::uuid ORDER BY sequence_order LIMIT 1) AS template_step_id
    ),
    run_rec AS (
        SELECT jsonb_populate_record(
            NULL::public.workflow_runs,
            jsonb_build_object(
                'id', run_id,
                'workflow_template_id', template_id,
                'workflow_template_version', 1,
                'entry_point', 'webhook',
                'workflow_status', 'pending',
                'retry_count', 0,
                'version', 1,
                'created_at', now(),
                'updated_at', now(),
                'context', jsonb_build_object(
                    'organization_id', org_id,
                    'client_id', client_id
                )
            )
        ) AS run
        FROM base
    ),
    step_rec AS (
        SELECT jsonb_populate_record(
            NULL::public.workflow_run_steps,
            jsonb_build_object(
                'id', gen_random_uuid(),
                'workflow_run_id', (SELECT run_id FROM base),
                'workflow_template_step_id', (SELECT template_step_id FROM base),
                'sequence_order', 0,
                'operation_name', 'reserve_identifiers',
                'manual_action_required', false,
                'metadata', '{}'::jsonb,
                'enabled', true,
                'handler_key', 'reserve_shipment_identifiers',
                'handler_version', 'v1',
                'step_status', 'pending',
                'retry_attempt', 1,
                'max_retries', 1,
                'created_at', now(),
                'updated_at', now(),
                'run_at', now(),
                'enqueued_at', now(),
                'runtime_state', '{}'::jsonb
            )
        ) AS step
        FROM base
    )
    SELECT workflow_handlers.reserve_identifiers_v1(step_rec.step, run_rec.run, '{}'::jsonb) AS response
    FROM step_rec, run_rec
)
SELECT ok(
    (reserve_result.response).context_patch->>'planned_resource_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    'reserve_identifiers_v1 returns planned_resource_id UUID'
)
FROM reserve_result;

-- context_extract_from_mapping handler test
INSERT INTO mapping_configs (
    id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes
)
VALUES (
    '99990000-0000-0000-0000-000000410001',
    'webhook_response',
    'context_patch::test_v1',
    jsonb_build_object('context_patch', jsonb_build_object('service_type', 'return')),
    1,
    'Temporary context patch for pgTAP'
)
ON CONFLICT (id) DO UPDATE SET
    mapping_config = EXCLUDED.mapping_config,
    mapping_version = EXCLUDED.mapping_version,
    notes = EXCLUDED.notes,
    updated_at = now();

WITH ctx_run AS (
    SELECT jsonb_populate_record(
        NULL::public.workflow_runs,
        jsonb_build_object(
            'id', gen_random_uuid(),
            'workflow_template_id', '99990000-0000-0000-0000-000000300002'::uuid,
            'workflow_template_version', 1,
            'entry_point', 'webhook',
            'workflow_status', 'pending',
            'retry_count', 0,
            'version', 1,
            'created_at', now(),
            'updated_at', now(),
            'context', jsonb_build_object(
                'organization_id', gen_random_uuid(),
                'client_id', gen_random_uuid(),
                'context_mapping_id', '99990000-0000-0000-0000-000000410001'::uuid
            )
        )
    ) AS run
),
ctx_step AS (
    SELECT jsonb_populate_record(
        NULL::public.workflow_run_steps,
        jsonb_build_object(
            'id', gen_random_uuid(),
            'workflow_run_id', (ctx_run.run).id,
            'workflow_template_step_id', (SELECT id FROM workflow_template_steps WHERE workflow_template_id = '99990000-0000-0000-0000-000000300002'::uuid ORDER BY sequence_order LIMIT 1),
            'sequence_order', 0,
            'operation_name', 'context_extract_from_mapping',
            'manual_action_required', false,
            'metadata', '{}'::jsonb,
            'enabled', true,
            'handler_key', 'context_extract_from_mapping',
            'handler_version', 'v1',
            'step_status', 'pending',
            'retry_attempt', 1,
            'max_retries', 1,
            'created_at', now(),
            'updated_at', now(),
            'run_at', now(),
            'enqueued_at', now(),
            'runtime_state', '{}'::jsonb
        )
    ) AS step
    FROM ctx_run
),
ctx_result AS (
    SELECT workflow_handlers.context_extract_from_mapping_v1(ctx_step.step, ctx_run.run, '{}'::jsonb) AS response
    FROM ctx_step, ctx_run
)
SELECT is(
    (ctx_result.response).context_patch->>'service_type',
    'return',
    'context_extract_from_mapping_v1 applies context_patch template'
)
FROM ctx_result;

WITH ctx_run AS (
    SELECT jsonb_populate_record(
        NULL::public.workflow_runs,
        jsonb_build_object(
            'id', gen_random_uuid(),
            'workflow_template_id', '99990000-0000-0000-0000-000000300002'::uuid,
            'workflow_template_version', 1,
            'entry_point', 'webhook',
            'workflow_status', 'pending',
            'retry_count', 0,
            'version', 1,
            'created_at', now(),
            'updated_at', now(),
            'context', jsonb_build_object(
                'organization_id', gen_random_uuid(),
                'client_id', gen_random_uuid(),
                'context_mapping_id', '99990000-0000-0000-0000-000000410001'::uuid
            )
        )
    ) AS run
),
ctx_step AS (
    SELECT jsonb_populate_record(
        NULL::public.workflow_run_steps,
        jsonb_build_object(
            'id', gen_random_uuid(),
            'workflow_run_id', (ctx_run.run).id,
            'workflow_template_step_id', (SELECT id FROM workflow_template_steps WHERE workflow_template_id = '99990000-0000-0000-0000-000000300002'::uuid ORDER BY sequence_order LIMIT 1),
            'sequence_order', 0,
            'operation_name', 'context_extract_from_mapping',
            'manual_action_required', false,
            'metadata', '{}'::jsonb,
            'enabled', true,
            'handler_key', 'context_extract_from_mapping',
            'handler_version', 'v1',
            'step_status', 'pending',
            'retry_attempt', 1,
            'max_retries', 1,
            'created_at', now(),
            'updated_at', now(),
            'run_at', now(),
            'enqueued_at', now(),
            'runtime_state', '{}'::jsonb
        )
    ) AS step
    FROM ctx_run
),
ctx_result AS (
    SELECT workflow_handlers.context_extract_from_mapping_v1(ctx_step.step, ctx_run.run, '{}'::jsonb) AS response
    FROM ctx_step, ctx_run
)
SELECT is(
    (ctx_result.response).operation_result->>'mapping_config_id',
    '99990000-0000-0000-0000-000000410001',
    'context_extract_from_mapping_v1 reports mapping_config_id'
)
FROM ctx_result;

WITH tpl AS (
    SELECT id
    FROM workflow_templates
    WHERE name = 'async_provider_dispatch_v1'
)
SELECT is(
    (
        SELECT handler_key
        FROM workflow_template_steps
        WHERE workflow_template_id = tpl.id
        ORDER BY sequence_order
        LIMIT 1
    ),
    'context_extract_from_mapping',
    'async_provider_dispatch_v1 starts with context_extract_from_mapping'
)
FROM tpl;

WITH tpl AS (
    SELECT id
    FROM workflow_templates
    WHERE name = 'async_provider_dispatch_v1'
)
SELECT is(
    (
        SELECT handler_key
        FROM workflow_template_steps
        WHERE workflow_template_id = tpl.id
        ORDER BY sequence_order
        OFFSET 1
        LIMIT 1
    ),
    'reserve_shipment_identifiers',
    'async_provider_dispatch_v1 reserves identifiers right after context extraction'
)
FROM tpl;

WITH tpl AS (
    SELECT id
    FROM workflow_templates
    WHERE name = 'shipment_return_v1'
)
SELECT is(
    (
        SELECT handler_key
        FROM workflow_template_steps
        WHERE workflow_template_id = tpl.id
        ORDER BY sequence_order
        LIMIT 1
    ),
    'context_extract_from_mapping',
    'shipment_return_v1 starts with context_extract_from_mapping'
)
FROM tpl;

WITH tpl AS (
    SELECT id
    FROM workflow_templates
    WHERE name = 'shipment_return_v1'
)
SELECT is(
    (
        SELECT handler_key
        FROM workflow_template_steps
        WHERE workflow_template_id = tpl.id
        ORDER BY sequence_order
        OFFSET 1
        LIMIT 1
    ),
    'reserve_shipment_identifiers',
    'shipment_return_v1 reserves identifiers immediately after context extraction'
)
FROM tpl;

SELECT * FROM finish();

ROLLBACK;
