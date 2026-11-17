-- Plan: PLAN-202512-label-print-sync-fast-bundle / Step: S99
-- Migration: Align label_design settings_versions.schema_version with active schema_registry version.
-- Purpose:
--   - Ensure seeded/global (and tenant) label_design settings_versions rows stay in sync
--     with the currently active label_design schema contract.
-- Notes:
--   - Idempotent: safe to rerun; updates only rows that differ from the active version.
BEGIN;
SET search_path TO public, extensions, pg_temp;

WITH active AS (
  SELECT version
  FROM public.schema_registry
  WHERE category = 'label_design'
    AND is_active = TRUE
  ORDER BY version DESC
  LIMIT 1
)
UPDATE public.settings_versions sv
SET schema_version = active.version
FROM active
WHERE sv.category = 'label_design'
  AND sv.schema_version IS DISTINCT FROM active.version;

COMMIT;
