-- Plan: PLAN-202601-label-designer-hardening / Step: S04
-- Migration: Clean up label_media_catalog settings rows before reseed
-- Purpose:
--   - Remove any partial/duplicate seed rows so the canonical seed migration
--     can apply cleanly.
BEGIN;
SET search_path TO public, extensions, pg_temp;

DELETE FROM public.settings
WHERE category = 'label_media_catalog';

DELETE FROM public.settings_versions
WHERE category = 'label_media_catalog';

DELETE FROM public.schema_registry
WHERE category = 'label_media_catalog';

COMMIT;
