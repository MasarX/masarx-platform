-- Archived Seed: webhook source mapping update for test-client-2-1
-- Note: provisioning handled by scripts/clients/provision-webhook-source.js.

BEGIN;

WITH client_row AS (
    SELECT c.id AS client_id, c.organization_id
    FROM clients c
    WHERE c.slug = 'test-client-2-1'
    LIMIT 1
),
sender_row AS (
    SELECT s.id AS sender_id
    FROM senders s
    WHERE s.client_id = (SELECT client_id FROM client_row)
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
        client_row.client_id,
        'Logestechs Client 2 Sender',
        'Logestechs Client 2',
        TRUE,
        TRUE,
        'active'
    FROM client_row
    WHERE NOT EXISTS (SELECT 1 FROM sender_row)
    RETURNING id
),
effective_sender AS (
    SELECT sender_id FROM sender_row
    UNION ALL
    SELECT id AS sender_id FROM inserted_sender
    LIMIT 1
),
mapping_upsert AS (
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
),
mapping_row AS (
    SELECT id AS mapping_id FROM mapping_upsert
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
    mapping_row.mapping_id,
    effective_sender.sender_id,
    1000,
    TRUE
FROM client_row, mapping_row, effective_sender
ON CONFLICT (source_identifier)
DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    auth_token = EXCLUDED.auth_token,
    mapping_config_id = EXCLUDED.mapping_config_id,
    sender_id = EXCLUDED.sender_id,
    enabled = TRUE,
    updated_at = now();

COMMIT;
