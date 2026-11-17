-- Migration: Sync geocoding_policy cached_value with settings_versions
-- Purpose:
--   resolve_settings reads settings.cached_value (SSOT for fast reads). If cached_value diverges
--   from settings_versions.value, workflows can run with stale policy (e.g., short_code plugin disabled).
--   This migration restores invariants for all geocoding_policy scopes by resyncing cached_value.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - SSOT - ZERO HARD CODING.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH src AS (
  SELECT s.id, sv.value
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'geocoding_policy'
)
UPDATE public.settings s
SET cached_value = src.value,
    last_updated = now()
FROM src
WHERE s.id = src.id
  AND s.cached_value IS DISTINCT FROM src.value;

COMMIT;

