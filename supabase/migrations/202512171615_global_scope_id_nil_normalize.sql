-- Migration: Normalize global scope_id nil -> NULL (fixup)
-- Purpose:
--   Some drifted environments may store global scope_id as the UUID nil value
--   instead of NULL, which breaks resolve_settings('...','global',NULL) lookups.
--   Normalize persisted rows to keep settings resolution deterministic.
-- Date: 2025-12-17

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.settings
SET scope_id = NULL
WHERE scope_type = 'global'
  AND scope_id = '00000000-0000-0000-0000-000000000000'::uuid;

UPDATE public.settings_versions
SET scope_id = NULL
WHERE scope_type = 'global'
  AND scope_id = '00000000-0000-0000-0000-000000000000'::uuid;

COMMIT;

