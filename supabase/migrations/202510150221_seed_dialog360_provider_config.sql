BEGIN;

WITH provider_row AS (
    SELECT id
    FROM providers
    WHERE name = 'dialog360_whatsapp'
    LIMIT 1
)
UPDATE providers
SET metadata = jsonb_strip_nulls(
        COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'base_url', 'https://waba-sandbox.360dialog.io',
            'channel', 'whatsapp'
        )
    ),
    updated_at = now()
WHERE id = (SELECT id FROM provider_row);

-- Credentials are provisioned via scripts/ops/configure-provider-auth.js after migrations run.

WITH provider_row AS (
    SELECT id
    FROM providers
    WHERE name = 'dialog360_whatsapp'
    LIMIT 1
),
defaults_payload AS (
    SELECT jsonb_build_object(
        'default_recipient', '+12025550123',
        'messaging_product', 'whatsapp'
    ) AS value
),
updated_versions AS (
    UPDATE settings_versions AS sv
    SET category = 'provider_dialog360_defaults',
        scope_type = 'resource',
        scope_id = (SELECT id FROM provider_row),
        version = 1,
        value = defaults_payload.value,
        schema_version = 1,
        change_reason = 'Seed 360dialog provider defaults',
        approved_at = now(),
        effective_from = now()
    FROM defaults_payload
    WHERE id = '99990000-0000-0000-0000-000000000002'
      AND (SELECT id FROM provider_row) IS NOT NULL
    RETURNING sv.id, sv.scope_id, sv.value
),
inserted_versions AS (
    INSERT INTO settings_versions (
        id,
        category,
        scope_type,
        scope_id,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
    )
    SELECT
        '99990000-0000-0000-0000-000000000002',
        'provider_dialog360_defaults',
        'resource',
        (SELECT id FROM provider_row),
        1,
        defaults_payload.value,
        1,
        'Seed 360dialog provider defaults',
        now(),
        now()
    FROM defaults_payload
    WHERE (SELECT id FROM provider_row) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM updated_versions)
    RETURNING id, scope_id, value
),
upsert_versions AS (
    SELECT * FROM updated_versions
    UNION ALL
    SELECT * FROM inserted_versions
)
INSERT INTO settings (
    category,
    scope_type,
    scope_id,
    settings_version_id,
    cached_value,
    last_updated
)
SELECT
    'provider_dialog360_defaults',
    'resource',
    upsert_versions.scope_id,
    upsert_versions.id,
    upsert_versions.value,
    now()
FROM upsert_versions
ON CONFLICT (category, scope_type, scope_id)
DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

COMMIT;
