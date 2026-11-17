-- Migration: Benchmark workflow scaffolding (geocoding benchmark runner + policy tags)
-- Purpose: Provide workflow templates and metadata to execute benchmark samples under different policy variants and log into benchmark_results via handlers.
-- Note: Execution/looping is handled at application/test level; this migration adds templates/metadata only (no hardcoding).

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Ensure benchmark runner workflow template exists
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
    '99990000-0000-0000-0000-0000004b0001',
    'workflow_geocoding_benchmark',
    'Runs geocoding against benchmark samples under a specified policy variant',
    'active',
    1,
    'global',
    NULL,
    'Benchmark harness template; handlers are policy-driven',
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
    published_at = COALESCE(wt.published_at, EXCLUDED.published_at),
    updated_at = now();

-- Steps: reuse standard geocoding handlers; orchestration is policy-driven
DELETE FROM public.workflow_template_steps WHERE workflow_template_id = '99990000-0000-0000-0000-0000004b0001';

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
    ('99990000-0000-0000-0000-0000004b1001'::uuid, '99990000-0000-0000-0000-0000004b0001'::uuid, 1, 'lookup_cache', 'geocoding', 'always', 'geocode_cache', 'v1',
        jsonb_build_object('action', 'read', 'decision_log_event', 'benchmark.cache_check'),
        false, true
    ),
    ('99990000-0000-0000-0000-0000004b1002'::uuid, '99990000-0000-0000-0000-0000004b0001'::uuid, 2, 'validate_coordinates', 'geocoding', 'always', 'geo_coordinate', 'v1',
        jsonb_build_object('validate_bounds', TRUE, 'decision_log_event', 'benchmark.validate_coordinates'),
        false, true
    ),
    ('99990000-0000-0000-0000-0000004b1003'::uuid, '99990000-0000-0000-0000-0000004b0001'::uuid, 3, 'normalize_components', 'geocoding', 'always', 'geo_normalize', 'v1',
        jsonb_build_object('decision_log_event', 'benchmark.normalize_components'),
        false, true
    ),
    ('99990000-0000-0000-0000-0000004b1004'::uuid, '99990000-0000-0000-0000-0000004b0001'::uuid, 4, 'local_lookup', 'geocoding', 'always', 'geo_local_lookup', 'v1',
        jsonb_build_object('decision_log_event', 'benchmark.local_lookup'),
        false, true
    ),
    ('99990000-0000-0000-0000-0000004b1005'::uuid, '99990000-0000-0000-0000-0000004b0001'::uuid, 5, 'provider_dispatch', 'geocoding', 'always', 'provider_dispatch', 'v1',
        jsonb_build_object('decision_log_event', 'benchmark.provider_dispatch'),
        false, true
    ),
    ('99990000-0000-0000-0000-0000004b1006'::uuid, '99990000-0000-0000-0000-0000004b0001'::uuid, 6, 'decision', 'geocoding', 'always', 'geo_decision', 'v1',
        jsonb_build_object('decision_log_event', 'benchmark.decision'),
        false, true
    ),
    ('99990000-0000-0000-0000-0000004b1007'::uuid, '99990000-0000-0000-0000-0000004b0001'::uuid, 7, 'cache_write', 'geocoding', 'always', 'geocode_cache', 'v1',
        jsonb_build_object('action', 'write', 'decision_log_event', 'benchmark.cache_write'),
        false, true
    );

-- Tag the template so application/tests can discover it dynamically
COMMIT;
