-- Minimal seed data for Logestechs client 2 to enable WhatsApp workflow tests.

BEGIN;

WITH org_row AS (
    INSERT INTO organizations (
        id,
        name,
        slug,
        timezone,
        locale,
        billing_status
    )
    VALUES (
        'ce455733-0968-43c4-b0d6-5bc027638d70'::uuid,
        'Automation QA Organization',
        'automation-qa-org',
        'Asia/Riyadh',
        'ar-SA',
        'active'
    )
    ON CONFLICT (slug)
    DO UPDATE SET
        name = EXCLUDED.name,
        timezone = EXCLUDED.timezone,
        locale = EXCLUDED.locale,
        billing_status = EXCLUDED.billing_status,
        updated_at = now()
    RETURNING id
),
client_row AS (
    INSERT INTO clients (
        organization_id,
        name,
        slug,
        sla_tier,
        status,
        settings_override
    )
    SELECT
        org_row.id,
        'Logestechs Automation Client 2',
        'test-client-2-1',
        'standard',
        'active',
        '{}'::jsonb
    FROM org_row
    ON CONFLICT (organization_id, slug)
    DO UPDATE SET
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        updated_at = now()
    RETURNING id, organization_id
),
existing_sender AS (
    SELECT s.id, s.client_id
    FROM senders s
    WHERE s.client_id = (SELECT id FROM client_row)
    ORDER BY s.created_at ASC
    LIMIT 1
),
inserted_sender AS (
    INSERT INTO senders (
        client_id,
        name,
        brand_name,
        auto_provisioned,
        auto_recreate,
        status
    )
    SELECT
        client_row.id,
        'Logestechs Client 2 Sender',
        'Logestechs QA',
        TRUE,
        TRUE,
        'active'
    FROM client_row
    WHERE NOT EXISTS (SELECT 1 FROM existing_sender)
    RETURNING id, client_id
),
sender_row AS (
    SELECT id, client_id FROM existing_sender
    UNION ALL
    SELECT id, client_id FROM inserted_sender
    LIMIT 1
),
existing_provider AS (
    SELECT id
    FROM providers
    WHERE organization_id = (SELECT organization_id FROM client_row)
      AND name = 'dialog360_whatsapp'
    LIMIT 1
),
inserted_provider AS (
    INSERT INTO providers (
        organization_id,
        name,
        provider_type,
        priority_rank,
        metadata
    )
    SELECT
        client_row.organization_id,
        'dialog360_whatsapp',
        'comms',
        100,
        jsonb_build_object(
            'channel', 'whatsapp',
            'base_url', 'https://waba-sandbox.360dialog.io'
        )
    FROM client_row
    WHERE NOT EXISTS (SELECT 1 FROM existing_provider)
    RETURNING id
),
provider_row AS (
    SELECT id FROM existing_provider
    UNION ALL
    SELECT id FROM inserted_provider
    LIMIT 1
),
-- Provider credentials are managed outside of migrations (see scripts/ops/configure-provider-auth.js).
mapping_row AS (
    INSERT INTO mapping_configs (
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
    )
    VALUES (
        'webhook_inbound',
        'test-async-client2::shipment.updated',
        jsonb_build_object(
            'description', 'Logestechs client 2 async webhook mapping',
            'external_id_path', 'event.id',
            'event_type_path', 'event.type',
            'transforms', jsonb_build_object(
                'shipment', jsonb_build_object(
                    'tracking_number', 'shipment.tracking_number',
                    'customer_phone', 'shipment.customer.phone',
                    'requires_geocoding', 'shipment.requested_services',
                    'delivery_city', 'shipment.address.city'
                )
            )
        ),
        1,
        'Async webhook mapping for Logestechs client 2'
    )
    ON CONFLICT (mapping_type, mapping_key)
    DO UPDATE SET
        mapping_config = EXCLUDED.mapping_config,
        notes = EXCLUDED.notes,
        updated_at = now()
    RETURNING id
)
INSERT INTO webhook_sources (
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    sender_id,
    rate_limit_per_hour,
    enabled
)
SELECT
    client_row.organization_id,
    'test-async-client2',
    'Logestechs Client 2 Async Source',
    'async_3pl',
    'EXAMPLE_PASSWORD-client2',
    mapping_row.id,
    sender_row.id,
    1000,
    TRUE
FROM client_row, sender_row, mapping_row
ON CONFLICT (source_identifier)
DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    auth_token = EXCLUDED.auth_token,
    mapping_config_id = EXCLUDED.mapping_config_id,
    sender_id = EXCLUDED.sender_id,
    enabled = TRUE,
    updated_at = now();

COMMIT;
