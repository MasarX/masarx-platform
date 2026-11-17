-- Archived Seed: ensure webhook source for test-client-2-1
-- Note: retained for reference. Use scripts/clients/provision-webhook-source.js going forward.

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
mapping_row AS (
    SELECT id AS mapping_id
    FROM mapping_configs
    WHERE mapping_type = 'webhook_inbound'
      AND mapping_key = 'test-async-source::shipment.created'
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
async_mapping AS (
    SELECT mapping_id FROM mapping_row
    UNION ALL
    SELECT id AS mapping_id
    FROM mapping_configs
    WHERE mapping_type = 'webhook_inbound'
      AND mapping_key = 'test-async-source::shipment.created'
    LIMIT 1
),
upsert_source AS (
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
        async_mapping.mapping_id,
        effective_sender.sender_id,
        1000,
        TRUE
    FROM client_row, async_mapping, effective_sender
    ON CONFLICT (source_identifier)
    DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        auth_token = EXCLUDED.auth_token,
        mapping_config_id = EXCLUDED.mapping_config_id,
        sender_id = EXCLUDED.sender_id,
        enabled = TRUE,
        updated_at = now()
    RETURNING id
)
SELECT 1
FROM upsert_source;

COMMIT;
