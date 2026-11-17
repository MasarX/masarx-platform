-- Migration: Label generation workflow updates
-- Purpose: Normalise workflow templates/steps so label job orchestration is fully
--          configuration-driven ahead of dispatcher refactor (202510200009).
-- Alignment: SIMPLE * SCALABLE * DYNAMIC * ZERO-HARD-CODING * PERMANENT

BEGIN;

ALTER TABLE workflow_template_steps
    ADD COLUMN IF NOT EXISTS handler_key TEXT;

ALTER TABLE workflow_template_steps
    ADD COLUMN IF NOT EXISTS handler_version TEXT;

-- Ensure canonical workflow templates are active and carry descriptive notes.
UPDATE workflow_templates
SET
    status = 'active',
    notes = COALESCE(
        NULLIF(notes, ''),
        'Includes label job enqueue + wait steps prior to comms dispatch.'
    ),
    updated_at = now()
WHERE name IN (
    'logestechs_shipment_ack_v1',
    'async_provider_dispatch_v1'
);

-- Upsert label generation enqueue metadata (adds defaults without overwriting bespoke values).
WITH enqueue_steps AS (
    SELECT
        id,
        workflow_template_id,
        COALESCE(metadata, '{}'::jsonb) AS meta
    FROM workflow_template_steps
    WHERE operation_name = 'generate_label_job'
)
UPDATE workflow_template_steps wts
SET
    metadata = jsonb_strip_nulls(
        meta
        || CASE
            WHEN meta ? 'action' THEN '{}'::jsonb
            ELSE jsonb_build_object('action', 'enqueue')
        END
        || CASE
            WHEN meta ? 'label_type' THEN '{}'::jsonb
            ELSE jsonb_build_object('label_type', 'shipping')
        END
        || CASE
            WHEN meta ? 'job_purpose' THEN '{}'::jsonb
            ELSE jsonb_build_object('job_purpose', 'primary')
        END
        || CASE
            WHEN meta ? 'requested_source' THEN '{}'::jsonb
            ELSE jsonb_build_object('requested_source', 'workflow')
        END
        || CASE
            WHEN meta ? 'max_retries' THEN '{}'::jsonb
            ELSE jsonb_build_object('max_retries', 3)
        END
    ),
    handler_key = COALESCE(wts.handler_key, 'label_job'),
    handler_version = COALESCE(wts.handler_version, 'v1')
FROM enqueue_steps es
WHERE wts.id = es.id;

-- Upsert label generation wait metadata (poll cadence, action).
WITH wait_steps AS (
    SELECT
        id,
        workflow_template_id,
        COALESCE(metadata, '{}'::jsonb) AS meta
    FROM workflow_template_steps
    WHERE operation_name = 'wait_for_label_job'
)
UPDATE workflow_template_steps wts
SET
    metadata = jsonb_strip_nulls(
        meta
        || CASE
            WHEN meta ? 'action' THEN '{}'::jsonb
            ELSE jsonb_build_object('action', 'wait')
        END
        || CASE
            WHEN meta ? 'poll_interval_seconds' THEN '{}'::jsonb
            ELSE jsonb_build_object('poll_interval_seconds', 60)
        END
        || CASE
            WHEN meta ? 'max_wait_seconds' THEN '{}'::jsonb
            ELSE jsonb_build_object('max_wait_seconds', 900)
        END
        || CASE
            WHEN meta ? 'max_retries' THEN '{}'::jsonb
            ELSE jsonb_build_object('max_retries', 60)
        END
    ),
    handler_key = COALESCE(wts.handler_key, 'label_job'),
    handler_version = COALESCE(wts.handler_version, 'v1')
FROM wait_steps ws
WHERE wts.id = ws.id;

-- Guarantee workflow step sequencing for label orchestration remains intact.
WITH logestechs_template AS (
    SELECT id FROM workflow_templates WHERE name = 'logestechs_shipment_ack_v1' LIMIT 1
), async_template AS (
    SELECT id FROM workflow_templates WHERE name = 'async_provider_dispatch_v1' LIMIT 1
)
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
    handler_key,
    handler_version
)
VALUES
    (
        '99990000-0000-0000-0000-000000310006',
        (SELECT id FROM logestechs_template),
        2,
        'generate_label_job',
        'workflow',
        'always',
        NULL,
        'wait_for_label_job',
        70,
        NULL,
        FALSE,
        jsonb_build_object(
            'action', 'enqueue',
            'label_type', 'shipping',
            'job_purpose', 'primary',
        'requested_source', 'workflow.logestechs',
            'max_retries', 1
        ),
        'label_job',
        'v1'
    ),
    (
        '99990000-0000-0000-0000-000000310007',
        (SELECT id FROM logestechs_template),
        3,
        'wait_for_label_job',
        'workflow',
        'always',
        NULL,
        'enqueue_notification',
        65,
        NULL,
        FALSE,
        jsonb_build_object(
            'action', 'wait',
            'poll_interval_seconds', 30,
            'max_wait_seconds', 900,
            'max_retries', 60
        ),
        'label_job',
        'v1'
    )
ON CONFLICT (id) DO UPDATE
SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    operation_settings_category = EXCLUDED.operation_settings_category,
    transition_condition = EXCLUDED.transition_condition,
    condition_jsonlogic = EXCLUDED.condition_jsonlogic,
    next_operation_name = EXCLUDED.next_operation_name,
    next_operation_priority = EXCLUDED.next_operation_priority,
    next_operation_delay_seconds = EXCLUDED.next_operation_delay_seconds,
    manual_action_required = EXCLUDED.manual_action_required,
    metadata = jsonb_strip_nulls(
        COALESCE(workflow_template_steps.metadata, '{}'::jsonb)
        || EXCLUDED.metadata
    ),
    handler_key = COALESCE(workflow_template_steps.handler_key, EXCLUDED.handler_key),
    handler_version = COALESCE(workflow_template_steps.handler_version, EXCLUDED.handler_version);

COMMIT;
