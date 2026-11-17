-- Migration: Outbound wrapper workflow template
-- Purpose: Provide a canonical wrapper workflow for outbound call enqueue when no active workflow context is present.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    notes,
    created_at,
    updated_at
)
VALUES (
    '99990000-0000-0000-0000-000000350000',
    'outbound_wrapper_v1',
    'Wrapper workflow for outbound call enqueue when no workflow context is present.',
    1,
    'active',
    'global',
    NULL,
    'Synthetic wrapper for outbound enqueue paths.',
    now(),
    now()
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    status = 'active',
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

INSERT INTO workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    condition_jsonlogic,
    next_operation_name,
    next_operation_priority,
    next_operation_delay_seconds,
    manual_action_required,
    metadata,
    enabled,
    created_at,
    updated_at,
    handler_key,
    handler_version
)
VALUES (
    '99990000-0000-0000-0000-000000350101',
    '99990000-0000-0000-0000-000000350000',
    1,
    'legacy_outbound_job',
    'workflow',
    'always',
    NULL,
    NULL,
    NULL,
    NULL,
    FALSE,
    jsonb_build_object(
        'action', 'enqueue',
        'requested_source', 'workflow.outbound_wrapper'
    ),
    TRUE,
    now(),
    now(),
    'outbound_http',
    'v1'
)
ON CONFLICT (id) DO UPDATE
SET operation_name = EXCLUDED.operation_name,
    operation_settings_category = EXCLUDED.operation_settings_category,
    transition_condition = EXCLUDED.transition_condition,
    condition_jsonlogic = EXCLUDED.condition_jsonlogic,
    next_operation_name = EXCLUDED.next_operation_name,
    next_operation_priority = EXCLUDED.next_operation_priority,
    next_operation_delay_seconds = EXCLUDED.next_operation_delay_seconds,
    manual_action_required = EXCLUDED.manual_action_required,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();

WITH checksums AS (
    SELECT
        workflow_template_id,
        md5(
            string_agg(
                concat_ws(
                    '|',
                    sequence_order,
                    operation_name,
                    COALESCE(next_operation_name, ''),
                    COALESCE(operation_settings_category, ''),
                    COALESCE(transition_condition, ''),
                    COALESCE(handler_key, ''),
                    COALESCE(handler_version, ''),
                    COALESCE(metadata::text, '')
                ),
                '||' ORDER BY sequence_order
            )
        ) AS checksum
    FROM workflow_template_steps
    WHERE workflow_template_id = '99990000-0000-0000-0000-000000350000'::uuid
    GROUP BY workflow_template_id
)
UPDATE workflow_templates wt
SET steps_checksum = checksums.checksum,
    status = 'active',
    published_at = COALESCE(wt.published_at, now()),
    updated_at = now()
FROM checksums
WHERE wt.id = checksums.workflow_template_id;

COMMIT;
