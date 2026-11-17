-- Migration: Repair workflow_geocoding_standard to include local_lookup with proper ordering

BEGIN;

DO $$
DECLARE
    v_template_id UUID;
    v_local_step_id UUID := gen_random_uuid();
    v_has_local BOOLEAN;
BEGIN
    SELECT id INTO v_template_id
    FROM workflow_templates
    WHERE name = 'workflow_geocoding_standard'
    LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE NOTICE 'workflow_geocoding_standard not found; skipping repair';
        RETURN;
    END IF;

    SELECT TRUE INTO v_has_local
    FROM workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'local_lookup'
    LIMIT 1;

    IF NOT v_has_local THEN
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
            3,
            'local_lookup',
            'geocoding',
            'always',
            'geo_local_lookup',
            'v1',
            jsonb_build_object('decision_log_event', 'geocoding.local_lookup'),
            FALSE,
            TRUE
        );
    END IF;

    -- Normalize sequence ordering to keep cache -> validate -> local -> normalize -> dispatch -> evaluate -> fallback -> manual -> cache write -> finalize -> provider_error
    WITH desired AS (
        SELECT * FROM (VALUES
            ('lookup_cache', 1),
            ('validate_coordinates', 2),
            ('local_lookup', 3),
            ('normalize_components', 4),
            ('dispatch_provider', 5),
            ('evaluate_result', 6),
            ('fallback_provider', 7),
            ('manual_review', 8),
            ('cache_write', 9),
            ('finalize_outcome', 10),
            ('provider_error', 11)
        ) AS t(operation_name, seq)
    )
    UPDATE workflow_template_steps wts
    SET sequence_order = d.seq,
        updated_at = now()
    FROM desired d
    WHERE wts.workflow_template_id = v_template_id
      AND wts.operation_name = d.operation_name;

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
