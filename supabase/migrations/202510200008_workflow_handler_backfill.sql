-- Migration: Workflow handler backfill
-- Purpose: Populate handler metadata on templates/steps and refresh template checksums.
-- Date: 2025-10-20

BEGIN;

-- Helper: recompute checksum and optionally increment template version.
CREATE OR REPLACE FUNCTION workflow_refresh_steps_checksum(
    p_template_id UUID,
    p_increment_version BOOLEAN DEFAULT TRUE
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_checksum TEXT;
BEGIN
    SELECT md5(
        COALESCE(
            string_agg(
                concat_ws(
                    '|',
                    sequence_order,
                    operation_name,
                    COALESCE(next_operation_name, ''),
                    COALESCE(operation_settings_category, ''),
                    COALESCE(transition_condition, ''),
                    COALESCE(condition_jsonlogic::TEXT, ''),
                    COALESCE(manual_action_required::TEXT, 'false'),
                    COALESCE(enabled::TEXT, 'true'),
                    COALESCE(metadata::TEXT, ''),
                    COALESCE(handler_key, ''),
                    COALESCE(handler_version, '')
                ),
                '||'
                ORDER BY sequence_order
            ),
            ''
        )
    )
    INTO v_checksum
    FROM workflow_template_steps
    WHERE workflow_template_id = p_template_id;

    UPDATE workflow_templates
    SET steps_checksum = v_checksum,
        version = CASE WHEN p_increment_version THEN version + 1 ELSE version END,
        updated_at = now()
    WHERE id = p_template_id;

    RETURN v_checksum;
END;
$$;

COMMENT ON FUNCTION workflow_refresh_steps_checksum(UUID, BOOLEAN)
    IS 'Recalculate a workflow template''s steps checksum (optionally bumping version) after metadata changes.';

UPDATE operation_templates
SET handler_key = COALESCE(handler_key, 'outbound_http'),
    handler_version = COALESCE(handler_version, 'v1')
WHERE handler_key IS DISTINCT FROM 'outbound_http';

WITH updated_label_generate AS (
    UPDATE workflow_template_steps
    SET
        handler_key = 'label_job',
        handler_version = 'v1',
        metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('handler_key', 'label_job', 'action', 'enqueue')
    WHERE operation_name = 'generate_label_job'
    RETURNING workflow_template_id
),
updated_label_wait AS (
    UPDATE workflow_template_steps
    SET
        handler_key = 'label_job',
        handler_version = 'v1',
        metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('handler_key', 'label_job', 'action', 'wait')
    WHERE operation_name = 'wait_for_label_job'
    RETURNING workflow_template_id
),
updated_workflow_control AS (
    UPDATE workflow_template_steps
    SET
        handler_key = 'workflow_control',
        handler_version = 'v1',
        metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('handler_key', 'workflow_control', 'action', 'complete')
    WHERE operation_name = 'record_workflow_completion'
    RETURNING workflow_template_id
),
updated_operation_steps AS (
    UPDATE workflow_template_steps
    SET
        handler_key = COALESCE(handler_key, 'outbound_http'),
        handler_version = COALESCE(handler_version, 'v1'),
        metadata = CASE
            WHEN metadata ? 'handler_key' THEN metadata
            ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('handler_key', 'outbound_http')
        END
    WHERE operation_settings_category = 'operation_template'
      AND handler_key IS DISTINCT FROM 'outbound_http'
    RETURNING workflow_template_id
),
affected_templates AS (
    SELECT DISTINCT workflow_template_id
    FROM (
        SELECT workflow_template_id FROM updated_label_generate
        UNION
        SELECT workflow_template_id FROM updated_label_wait
        UNION
        SELECT workflow_template_id FROM updated_workflow_control
        UNION
        SELECT workflow_template_id FROM updated_operation_steps
    ) s
)
SELECT workflow_refresh_steps_checksum(workflow_template_id)
FROM affected_templates;

UPDATE workflow_run_steps wrs
SET
    handler_key = COALESCE(wrs.handler_key, wts.handler_key),
    handler_version = COALESCE(wrs.handler_version, wts.handler_version)
FROM workflow_template_steps wts
WHERE wrs.workflow_template_step_id = wts.id
  AND (wrs.handler_key IS NULL OR wrs.handler_version IS NULL);

COMMIT;

