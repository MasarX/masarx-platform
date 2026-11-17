BEGIN;

WITH provider_row AS (
    SELECT id
    FROM providers
    WHERE name = 'logestechs_3pl'
    LIMIT 1
)
UPDATE providers
SET metadata = jsonb_strip_nulls(
        COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'base_url', 'https://apisv2.logestechs.com',
            'company_id', '362'
        )
    ),
    updated_at = now()
WHERE id = (SELECT id FROM provider_row);

-- Credentials are injected post-migration via scripts/ops/configure-provider-auth.js.
SELECT 1;

WITH provider_row AS (
    SELECT id
    FROM providers
    WHERE name = 'logestechs_3pl'
    LIMIT 1
),
payload AS (
    SELECT jsonb_build_object(
        'service_type', 'STANDARD',
        'shipment_type', 'REGULAR',
        'integration_source', 'INTEGRATION',
        'sender_name', 'AutomationSender',
        'business_sender_name', 'AutomationSender',
        'sender_phone', '544288859',
        'receiver_name', 'QA Receiver',
        'receiver_phone', '+12025550123',
        'receiver_phone_secondary', NULL,
        'package_item_name', 'Automation Item',
        'package_notes', '',
        'description', 'Automation order',
        'destination_village', 'الرياض',
        'unit_type', 'METRIC',
        'package_weight', 1,
        'package_width', NULL,
        'package_length', NULL,
        'package_height', NULL,
        'cod', 0,
        'package_template', jsonb_build_object(
            'weight', 1,
            'quantity', 1,
            'width', 10,
            'length', 10,
            'height', 10,
            'packageItemsToDeliverList', NULL
        ),
        'origin_template', jsonb_build_object(
            'addressLine1', 'Automation Warehouse',
            'cityId', 230194,
            'villageId', 343332,
            'regionId', 1265
        ),
        'destination_template', jsonb_build_object(
            'addressLine1', 'Automation Customer',
            'cityId', 230194,
            'villageId', 343332,
            'regionId', 1265
        ),
        'package_items', NULL
    ) AS value
),
updated_versions AS (
    UPDATE settings_versions AS sv
    SET category = 'provider_logestechs_defaults',
        scope_type = 'resource',
        scope_id = (SELECT id FROM provider_row),
        version = 1,
        value = payload.value,
        schema_version = 1,
        change_reason = 'Seed Logestechs provider defaults for automated workflows',
        approved_at = now(),
        effective_from = now()
    FROM payload
    WHERE id = '99990000-0000-0000-0000-000000000001'::uuid
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
        '99990000-0000-0000-0000-000000000001'::uuid,
        'provider_logestechs_defaults',
        'resource',
        (SELECT id FROM provider_row),
        1,
        payload.value,
        1,
        'Seed Logestechs provider defaults for automated workflows',
        now(),
        now()
    FROM provider_row, payload
    WHERE NOT EXISTS (SELECT 1 FROM updated_versions)
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
    'provider_logestechs_defaults',
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
