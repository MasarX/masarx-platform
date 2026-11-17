-- Migration: Geocoding policy local_lookup skip_when_short_code
-- Purpose:
--   - Allow local_lookup.skip_when_short_code in geocoding_policy schema.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Plan: PLAN-202601-geo-short-code-skip-local / Step: S02
-- Date: 2026-01-12
BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Schema: geocoding_policy v5 (local_lookup.skip_when_short_code)
-------------------------------------------------------------------------------
WITH base AS (
  SELECT schema, description, examples
  FROM public.schema_registry
  WHERE category = 'geocoding_policy'
    AND is_active = TRUE
  ORDER BY version DESC
  LIMIT 1
),
patched AS (
  SELECT
    jsonb_set(
      base.schema,
      '{properties,local_lookup,properties,skip_when_short_code}',
      jsonb_build_object('type', 'boolean'),
      TRUE
    ) AS schema,
    base.description,
    base.examples
  FROM base
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'geocoding_policy',
  5,
  patched.schema,
  COALESCE(patched.description, 'geocoding_policy schema') || ' (v5: local_lookup skip_when_short_code)',
  patched.examples,
  TRUE
FROM patched
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

UPDATE public.schema_registry
SET is_active = CASE WHEN version = 5 THEN TRUE ELSE FALSE END
WHERE category = 'geocoding_policy';

COMMIT;
