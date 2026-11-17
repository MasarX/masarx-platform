-- Migration: Seed partition_defaults (global) and schema registry
-- Purpose: Provide resolver-driven default for create_next_partitions (no literals)
-- Date: 2025-11-25 10:00

BEGIN;

-- 1) Register minimal schema for partition_defaults (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_registry WHERE category = 'partition_defaults' AND version = 1
  ) THEN
    INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
    VALUES (
      'partition_defaults',
      1,
      '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "partitions_ahead": { "type": "integer", "minimum": 1 }
        }
      }'::jsonb,
      'Global defaults for partition management (e.g., partitions_ahead) v1',
      '[{"partitions_ahead": 4}]'::jsonb,
      TRUE
    );
  END IF;
END $$;

-- 2) Insert global partition_defaults if missing; cache in settings
WITH payload AS (
  SELECT 'partition_defaults'::text AS category,
         jsonb_build_object('partitions_ahead', 4) AS body
), ins AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, approved_at)
  SELECT p.category, 'global', NULL::uuid, 1, p.body, now()
  FROM payload p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = p.category AND sv.scope_type = 'global' AND sv.scope_id IS NULL
  )
  RETURNING id, category, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT i.category, 'global', NULL::uuid, i.id, i.value, now()
FROM ins i
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s WHERE s.category = i.category AND s.scope_type = 'global' AND s.scope_id IS NULL
);

COMMIT;

