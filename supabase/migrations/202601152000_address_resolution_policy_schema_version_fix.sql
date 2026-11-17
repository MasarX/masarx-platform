-- Migration: Address resolution policy schema version fix
-- Purpose:
--   - Ensure address_resolution_policy settings_versions rows carry schema_version.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15

BEGIN;

WITH latest AS (
  SELECT version
  FROM public.schema_registry
  WHERE category = 'address_resolution_policy'
  ORDER BY version DESC
  LIMIT 1
)
UPDATE public.settings_versions sv
SET schema_version = latest.version
FROM latest
WHERE sv.category = 'address_resolution_policy'
  AND sv.schema_version IS NULL
  AND latest.version IS NOT NULL;

COMMIT;
