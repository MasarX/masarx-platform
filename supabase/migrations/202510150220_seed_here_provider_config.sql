BEGIN;

WITH provider_row AS (
    SELECT id
    FROM providers
    WHERE name = 'here_geocoding'
    LIMIT 1
)
UPDATE providers
SET metadata = jsonb_strip_nulls(
        COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'base_url', 'https://geocode.search.hereapi.com/v1'
        )
    ),
    updated_at = now()
WHERE id = (SELECT id FROM provider_row);

-- Credentials are injected via automation (see scripts/ops/configure-provider-auth.js).
-- This migration intentionally leaves provider_auth_configs untouched.
SELECT 1;

COMMIT;
