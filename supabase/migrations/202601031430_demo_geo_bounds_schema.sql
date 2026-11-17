-- Migration: demo_geo_bounds schema registry
-- Purpose:
--   - Register schema for demo_geo_bounds settings used by live pitch demos.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - SSOT - ZERO HARD CODING.
-- Date: 2026-01-03

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH schema_payload AS (
  SELECT jsonb_build_object(
    'type', 'object',
    'additionalProperties', FALSE,
    'required', jsonb_build_array('city', 'country', 'areas'),
    'properties', jsonb_build_object(
      'city', jsonb_build_object('type', 'string', 'minLength', 1),
      'country', jsonb_build_object('type', 'string', 'minLength', 2, 'maxLength', 2),
      'language', jsonb_build_object('type', 'string', 'minLength', 2),
      'areas', jsonb_build_object(
        'type', 'object',
        'minProperties', 1,
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'additionalProperties', FALSE,
          'required', jsonb_build_array('latMin', 'latMax', 'lonMin', 'lonMax'),
          'properties', jsonb_build_object(
            'latMin', jsonb_build_object('type', 'number'),
            'latMax', jsonb_build_object('type', 'number'),
            'lonMin', jsonb_build_object('type', 'number'),
            'lonMax', jsonb_build_object('type', 'number')
          )
        )
      )
    )
  ) AS schema
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'demo_geo_bounds',
  1,
  schema,
  'demo_geo_bounds schema (demo geo bounding boxes for pitch workflows)',
  NULL,
  TRUE
FROM schema_payload
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

UPDATE public.schema_registry
SET is_active = CASE WHEN version = 1 THEN TRUE ELSE FALSE END
WHERE category = 'demo_geo_bounds';

COMMIT;
