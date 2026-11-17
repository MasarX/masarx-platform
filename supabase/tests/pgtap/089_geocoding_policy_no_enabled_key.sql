BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'geocoding_policy'
      AND sv.effective_until IS NULL
      AND (sv.value ? 'enabled')
  ),
  'Active geocoding_policy settings_versions contain no legacy enabled key'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'geocoding_policy'
      AND (s.cached_value ? 'enabled')
  ),
  'settings.cached_value for geocoding_policy contains no legacy enabled key'
);

SELECT finish();
ROLLBACK;

