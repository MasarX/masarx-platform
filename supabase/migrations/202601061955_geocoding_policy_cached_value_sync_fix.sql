-- Plan: PLAN-202601-address-versioned-addresses-pitch-progress / Step: S01

-- pgTAP expects settings.cached_value to mirror settings_versions.value.
-- Backfill any drift for geocoding_policy across all scopes.

UPDATE public.settings s
SET
  cached_value = sv.value,
  last_updated = now()
FROM public.settings_versions sv
WHERE sv.id = s.settings_version_id
  AND s.category = 'geocoding_policy'
  AND s.cached_value IS DISTINCT FROM sv.value;
