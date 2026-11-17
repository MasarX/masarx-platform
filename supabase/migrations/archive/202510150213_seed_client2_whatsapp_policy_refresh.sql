-- Archived Seed: webhook policy refresh for test-client-2-1
-- Retained for reference; superseded by scripts/clients/provision-client.js.

BEGIN;

WITH client_row AS (
    SELECT c.id AS client_id, c.organization_id
    FROM clients c
    WHERE c.slug = 'test-client-2-1'
    LIMIT 1
),
provider_row AS (
    SELECT id AS provider_id
    FROM providers
    WHERE name = 'dialog360_whatsapp'
    LIMIT 1
),
existing_recipient AS (
    SELECT id
    FROM recipients
    WHERE client_id = (SELECT client_id FROM client_row)
      AND phone_number = '+12025550123'
    LIMIT 1
),
updated_recipient AS (
    UPDATE recipients r
    SET
        name = 'Automation QA Recipient',
        preferred_language = 'en',
        preferred_comm_channel = 'whatsapp',
        communication_preferences = '{"whatsapp": {"enabled": true}}'::jsonb,
        updated_at = now()
    WHERE r.id = (SELECT id FROM existing_recipient)
    RETURNING r.id
),
inserted_recipient AS (
    INSERT INTO recipients (
        organization_id,
        client_id,
        name,
        phone_number,
        preferred_language,
        preferred_comm_channel,
        communication_preferences
    )
    SELECT
        cr.organization_id,
        cr.client_id,
        'Automation QA Recipient',
        '+12025550123',
        'en',
        'whatsapp',
        '{"whatsapp": {"enabled": true}}'::jsonb
    FROM client_row cr
    WHERE NOT EXISTS (SELECT 1 FROM existing_recipient)
    RETURNING id
),
recipient_row AS (
    SELECT id FROM updated_recipient
    UNION ALL
    SELECT id FROM inserted_recipient
),
mapping_row AS (
    INSERT INTO mapping_configs (
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
    )
    VALUES (
        'webhook_outbound',
        'dialog360::whatsapp::logestechs_notification',
        '{"field_mappings": {}}'::jsonb,
        1,
        'Logestechs shipment update WhatsApp payload'
    )
    ON CONFLICT (mapping_type, mapping_key)
    DO UPDATE SET
        mapping_config = EXCLUDED.mapping_config,
        mapping_version = mapping_configs.mapping_version + 1,
        updated_at = now(),
        notes = EXCLUDED.notes
    RETURNING id
),
operation_row AS (
    INSERT INTO operation_templates (
        provider_id,
        operation_name,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        timeout_seconds
    )
    SELECT
        pr.provider_id,
        'send_whatsapp_text',
        'POST',
        'https://waba-sandbox.360dialog.io/v1/messages',
        jsonb_build_object(
            'content-type', 'application/json',
            'D360-API-KEY', (
                SELECT credentials->>'api_key'
                FROM provider_auth_configs
                WHERE provider_id = pr.provider_id
                LIMIT 1
            )
        ),
        jsonb_build_object(
            'messaging_product', 'whatsapp',
            'to', '+12025550123',
            'type', 'text',
            'text', jsonb_build_object('body', 'Logestechs shipment update received')
        ),
        NULL,
        mapping_row.id,
        30
    FROM provider_row pr
    CROSS JOIN mapping_row
    ON CONFLICT (provider_id, operation_name)
    DO UPDATE SET
        url_template = EXCLUDED.url_template,
        headers_template = EXCLUDED.headers_template,
        body_template = EXCLUDED.body_template,
        mapping_config_id = EXCLUDED.mapping_config_id,
        updated_at = now()
    RETURNING id
),
policy_value AS (
    SELECT jsonb_build_object(
        'version', 1,
        'wait_for_ack', false,
        'validation', jsonb_build_object(
            'idempotency', jsonb_build_object(
                'body_path', 'event.id'
            )
        ),
        'ack', jsonb_build_object(
            'mode', 'synchronous_success',
            'status_code', 200,
            'default_headers', jsonb_build_object('content-type', 'application/json')
        ),
        'workflow_followup', jsonb_build_object(
            'actions', jsonb_agg(
                jsonb_build_object(
                    'handler_key', 'call_supplier_api',
                    'arguments', jsonb_build_object(
                        'operation_template_id', operation_row.id,
                        'priority', 80,
                        'max_retries', 1
                    )
                )
            )
        ),
        'logging', jsonb_build_object(
            'decision_point', 'webhook_ack',
            'include_payload', true
        )
    ) AS value
    FROM operation_row
),
existing_policy AS (
    SELECT id
    FROM settings_versions_p0
    WHERE category = 'webhook_ingest_policy'
      AND scope_type = 'client'
      AND scope_id = (SELECT client_id FROM client_row)
    ORDER BY effective_from DESC
    LIMIT 1
),
updated_policy AS (
    UPDATE settings_versions_p0 sv
    SET
        value = policy_value.value,
        schema_version = 1,
        change_reason = 'Enable WhatsApp workflow follow-up notification for seeded Logestechs client',
        approved_at = now(),
        effective_from = now()
    FROM policy_value
    WHERE sv.id = (SELECT id FROM existing_policy)
    RETURNING sv.id
),
inserted_policy AS (
    INSERT INTO settings_versions_p0 (
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
        'webhook_ingest_policy',
        'client',
        client_row.client_id,
        1,
        policy_value.value,
        1,
        'Enable WhatsApp workflow follow-up notification for seeded Logestechs client',
        now(),
        now()
    FROM client_row, policy_value
    WHERE NOT EXISTS (SELECT 1 FROM existing_policy)
    RETURNING id
),
policy_version_row AS (
    SELECT id FROM updated_policy
    UNION ALL
    SELECT id FROM inserted_policy
),
existing_setting AS (
    SELECT id
    FROM settings
    WHERE category = 'webhook_ingest_policy'
      AND scope_type = 'client'
      AND scope_id = (SELECT client_id FROM client_row)
    LIMIT 1
),
updated_setting AS (
    UPDATE settings s
    SET
        settings_version_id = (SELECT id FROM policy_version_row LIMIT 1),
        cached_value = policy_value.value,
        last_updated = now()
    FROM policy_value
    WHERE s.id = (SELECT id FROM existing_setting)
    RETURNING s.id
),
inserted_setting AS (
    INSERT INTO settings (
        category,
        scope_type,
        scope_id,
        settings_version_id,
        cached_value,
        last_updated
    )
    SELECT
        'webhook_ingest_policy',
        'client',
        client_row.client_id,
        (SELECT id FROM policy_version_row LIMIT 1),
        policy_value.value,
        now()
    FROM client_row, policy_value
    WHERE NOT EXISTS (SELECT 1 FROM existing_setting)
    RETURNING id
)
SELECT
    (SELECT id FROM recipient_row LIMIT 1) AS recipient_id,
    (SELECT id FROM policy_version_row LIMIT 1) AS policy_settings_version_id,
    COALESCE(
        (SELECT id FROM inserted_setting LIMIT 1),
        (SELECT id FROM updated_setting LIMIT 1)
    ) AS settings_id;

COMMIT;


