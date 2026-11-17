-- Migration: Logestechs provider config cleanup
-- Purpose:
--   - Ensure providers.metadata for logestechs_3pl includes base_url and company_id.
--   - Normalise provider_defaults text fields to clean, descriptive values.

BEGIN;

SET search_path TO public, pg_temp;

-- Ensure provider metadata carries base_url + company_id (config, not auth).
WITH provider_row AS (
  SELECT id
  FROM providers
  WHERE name = 'logestechs_3pl'
  LIMIT 1
)
UPDATE providers p
SET metadata = jsonb_strip_nulls(
        COALESCE(p.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'base_url', 'https://apisv2.logestechs.com',
          'company_id', '362'
        )
    ),
    updated_at = now()
FROM provider_row pr
WHERE p.id = pr.id;

-- NOTE: Defaults for logestechs_3pl are now seeded in a dedicated migration
-- (202511291205_logestechs_provider_defaults_seed.sql). This cleanup step is
-- intentionally left empty to avoid brittle jsonb surgery in-place.

COMMIT;
