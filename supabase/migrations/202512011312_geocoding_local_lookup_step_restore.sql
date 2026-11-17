-- Migration: Restore local_lookup step in workflow_geocoding_standard if missing
-- Purpose: ensure local lookup executes before provider dispatch in all environments.

BEGIN;

DO $$
DECLARE
    v_template_id UUID;
    v_local_step_id UUID := '99990000-0000-0000-0000-000000410003';
    v_exists BOOLEAN;
BEGIN
    SELECT id INTO v_template_id
    FROM workflow_templates
    WHERE name = 'workflow_geocoding_standard'
    LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE NOTICE 'workflow_geocoding_standard not found; skipping local_lookup restore';
        RETURN;
    END IF;

    SELECT TRUE INTO v_exists
    FROM workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'local_lookup'
    LIMIT 1;

    IF v_exists THEN
        RETURN;
    END IF;

    -- Shift downstream steps to make room for local_lookup at position 4.
    UPDATE workflow_template_steps
    SET sequence_order = sequence_order + 1
    WHERE workflow_template_id = v_template_id
      AND sequence_order >= 4;

    INSERT INTO workflow_template_steps (
        id,
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        handler_key,
        handler_version,
        metadata,
        manual_action_required,
        enabled
    )
    VALUES (
        v_local_step_id,
        v_template_id,
        4,
        'local_lookup',
        'geocoding',
        'always',
        'geo_local_lookup',
        'v1',
        jsonb_build_object('decision_log_event', 'geocoding.local_lookup'),
        FALSE,
        TRUE
    )
    ON CONFLICT (id) DO UPDATE
    SET sequence_order = EXCLUDED.sequence_order,
        metadata = EXCLUDED.metadata,
        updated_at = now();

    -- Recompute steps_checksum
    WITH ordered_steps AS (
        SELECT
            sequence_order,
            jsonb_build_object(
                'sequence_order', sequence_order,
                'operation_name', operation_name,
                'handler_key', handler_key,
                'handler_version', handler_version,
                'metadata', COALESCE(metadata, '{}'::jsonb)
            ) AS payload
        FROM public.workflow_template_steps
        WHERE workflow_template_id = v_template_id
        ORDER BY sequence_order
    ),
    hashed AS (
        SELECT md5(coalesce(jsonb_agg(payload ORDER BY sequence_order)::text, '')) AS checksum
        FROM ordered_steps
    )
    UPDATE public.workflow_templates wt
    SET steps_checksum = hashed.checksum,
        updated_at = now()
    FROM hashed
    WHERE wt.id = v_template_id;
END
$$;

COMMIT;
