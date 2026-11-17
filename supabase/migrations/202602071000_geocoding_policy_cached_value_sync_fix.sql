-- Migration: geocoding_policy cached_value sync backfill
-- Purpose:
--   - Restore SSOT consistency where settings.cached_value diverged from
--     settings_versions.value for geocoding_policy rows.
--   - Keep resolver inputs deterministic for tests and runtime behavior.

UPDATE public.settings AS s
SET
  cached_value = sv.value,
  last_updated = clock_timestamp()
FROM public.settings_versions AS sv
WHERE s.category = 'geocoding_policy'
  AND sv.id = s.settings_version_id
  AND s.cached_value IS DISTINCT FROM sv.value;

