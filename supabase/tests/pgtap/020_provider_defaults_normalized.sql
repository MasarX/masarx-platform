-- Test: provider defaults categories are normalized to 'provider_defaults'

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- No legacy categories in settings_versions
SELECT ok(
  (
    SELECT COUNT(*)
    FROM settings_versions
    WHERE category IN ('provider_logestechs_defaults','provider_dialog360_defaults')
  ) = 0,
  'settings_versions contains no legacy provider_*_defaults categories'
);

-- No legacy categories in settings
SELECT ok(
  (
    SELECT COUNT(*)
    FROM settings
    WHERE category IN ('provider_logestechs_defaults','provider_dialog360_defaults')
  ) = 0,
  'settings contains no legacy provider_*_defaults categories'
);

SELECT * FROM finish();

ROLLBACK;

