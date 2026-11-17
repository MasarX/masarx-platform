-- pgTAP: geocoding_policy cached_value stays in sync with settings_versions

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

SET search_path TO public, pgtap, extensions, pg_temp;

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'geocoding_policy'
      AND s.cached_value IS DISTINCT FROM sv.value
  ),
  'geocoding_policy settings.cached_value is in sync with settings_versions.value'
);

SELECT finish();

ROLLBACK;

