-- Phase 3 – Declarative Workflow Restoration
-- Seeds the workflow_geocoding_standard template and its declarative steps.

BEGIN;

SELECT pg_advisory_lock(hashtext('20251101100000_workflow_geocoding_standard'));

SET search_path TO public;

-- Deterministic identifiers for template and steps.
DO $$
DECLARE
    v_template_id uuid := '99990000-0000-0000-0000-000000400001'::uuid;
BEGIN
    -- Upsert workflow template metadata.
    INSERT INTO public.workflow_templates AS wt (
        id,
        name,
        description,
        status,
        version,
        scope_type,
        scope_id,
        notes,
        published_at
    )
    VALUES (
        v_template_id,
        'workflow_geocoding_standard',
        'Standard geocoding workflow orchestrating cache precheck, provider dispatch, fallback, and manual review.',
        'active',
        1,
        'global',
        NULL,
        'Restored per Plan.md Phase 3 – dynamic geocoding pipeline',
        now()
    )
    ON CONFLICT (id) DO UPDATE
    SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        version = EXCLUDED.version,
        scope_type = EXCLUDED.scope_type,
        scope_id = EXCLUDED.scope_id,
        notes = EXCLUDED.notes,
        published_at = EXCLUDED.published_at,
        updated_at = now();

    -- Clear existing steps for idempotency.
    DELETE FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id;

    -- Insert ordered steps.
    INSERT INTO public.workflow_template_steps (
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
    VALUES
        ('99990000-0000-0000-0000-000000410001'::uuid, v_template_id, 1, 'lookup_cache', 'geocoding', 'always', 'geocode_cache', 'v1',
            jsonb_build_object(
                'action', 'read',
                'decision_log_event', 'geocoding.cache_check'
            ),
            false,
            true
        ),
        ('99990000-0000-0000-0000-000000410002'::uuid, v_template_id, 2, 'validate_coordinates', 'geocoding', 'always', 'geo_coordinate', 'v1',
            jsonb_build_object(
                'validate_bounds', TRUE,
                'decision_log_event', 'geocoding.validate_coordinates'
            ),
            false,
            true
        ),
        ('99990000-0000-0000-0000-000000410003'::uuid, v_template_id, 3, 'normalize_components', 'geocoding', 'always', 'geo_normalize', 'v1',
            jsonb_build_object(
                'decision_log_event', 'geocoding.normalize_components'
            ),
            false,
            true
        ),
        ('99990000-0000-0000-0000-000000410004'::uuid, v_template_id, 4, 'dispatch_provider', 'geocoding', 'always', 'provider_dispatch', 'v1',
            jsonb_build_object(
                'attempt_type', 'primary',
                'provider_id', 'f36008ee-9f91-4f28-a1d4-ae331a42bdfc',
                'provider_key', 'here_geocoding',
                'simulated_confidence', 0.62,
                'decision_log_event', 'geocoding.primary_dispatch'
            ),
            false,
            true
        ),
        ('99990000-0000-0000-0000-000000410005'::uuid, v_template_id, 5, 'evaluate_result', 'geocoding', 'always', 'geo_decision', 'v1',
            jsonb_build_object(
                'confidence_threshold', 0.75,
                'fallback_threshold', 0.65,
                'decision_log_event', 'geocoding.evaluate_result'
            ),
            false,
            true
        ),
        ('99990000-0000-0000-0000-000000410006'::uuid, v_template_id, 6, 'fallback_provider', 'geocoding', 'always', 'provider_dispatch', 'v1',
            jsonb_build_object(
                'attempt_type', 'fallback',
                'provider_id', '1fdf96b5-1c64-4c34-90d3-0ffa5014a4f8',
                'provider_key', 'google_maps',
                'simulated_confidence', 0.83,
                'decision_log_event', 'geocoding.fallback_dispatch'
            ),
            false,
            true
        ),
        ('99990000-0000-0000-0000-000000410007'::uuid, v_template_id, 7, 'manual_review', 'workflow', 'always', 'geocode_manual_review_enqueue', 'v1',
            jsonb_build_object(
                'queue_assignment', 'address_ops',
                'sla_minutes', 60,
                'decision_log_event', 'geocoding.manual_review'
            ),
            true,
            true
        ),
        ('99990000-0000-0000-0000-000000410008'::uuid, v_template_id, 8, 'cache_write', 'geocoding', 'always', 'geocode_cache', 'v1',
            jsonb_build_object(
                'action', 'write',
                'set_primary', TRUE,
                'decision_log_event', 'geocoding.cache_write'
            ),
            false,
            true
        ),
        ('99990000-0000-0000-0000-000000410009'::uuid, v_template_id, 9, 'finalize_outcome', 'workflow', 'always', 'workflow_control', 'v1',
            jsonb_build_object(
                'action', 'complete',
                'status', 'completed',
                'decision_log_event', 'geocoding.complete_success'
            ),
            false,
            true
        ),
        ('99990000-0000-0000-0000-000000410010'::uuid, v_template_id, 10, 'provider_error', 'workflow', 'always', 'workflow_control', 'v1',
            jsonb_build_object(
                'action', 'fail',
                'status', 'failed',
                'decision_log_event', 'geocoding.provider_error'
            ),
            false,
            true
        );

    -- Persist checksum for audit parity.
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

SELECT pg_advisory_unlock(hashtext('20251101100000_workflow_geocoding_standard'));

COMMIT;
