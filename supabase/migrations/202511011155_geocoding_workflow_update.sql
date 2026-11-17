-- Migration: Geocoding workflow step metadata refresh
-- Purpose: Point workflow template steps at operation templates (removing simulated metadata).

BEGIN;

UPDATE public.workflow_template_steps
SET metadata = jsonb_strip_nulls(
        (COALESCE(metadata, '{}'::jsonb) - 'simulated_confidence' - 'provider_id')
        || jsonb_build_object(
            'operation_template_id', '99990000-0000-0000-0000-000000250001',
            'attempt_type', 'primary',
            'lang', COALESCE(NULLIF(metadata->>'lang', ''), 'en'),
            'limit', COALESCE((metadata->>'limit')::INT, 1),
            'provider_key', COALESCE(metadata->>'provider_key', 'here_geocoding')
        )
    )
WHERE id = '99990000-0000-0000-0000-000000410004'::uuid;

UPDATE public.workflow_template_steps
SET metadata = jsonb_strip_nulls(
        (COALESCE(metadata, '{}'::jsonb) - 'simulated_confidence' - 'provider_id')
        || jsonb_build_object(
            'operation_template_id', '99990000-0000-0000-0000-000000250002',
            'attempt_type', 'fallback',
            'lang', COALESCE(NULLIF(metadata->>'lang', ''), 'en'),
            'limit', COALESCE((metadata->>'limit')::INT, 1),
            'provider_key', COALESCE(metadata->>'provider_key', 'google_maps')
        )
    )
WHERE id = '99990000-0000-0000-0000-000000410006'::uuid;

COMMIT;
