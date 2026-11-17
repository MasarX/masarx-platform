-- Migration: Align webhook_ingest_policy schema_registry with schema key
-- Purpose: Add `schema` property to v1 schema to match cached_value structure.

BEGIN;

UPDATE public.schema_registry
SET schema = jsonb_set(
  schema,
  '{properties,schema}',
  jsonb_build_object(
    'type', 'object',
    'additionalProperties', false,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'string'),
      'registry', jsonb_build_object('type', 'string')
    )
  ),
  true
)
WHERE category = 'webhook_ingest_policy'
  AND version = 1;

COMMIT;
