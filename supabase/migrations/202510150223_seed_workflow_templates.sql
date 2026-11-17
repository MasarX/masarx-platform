-- Migration: Seed canonical workflow templates and supporting operation metadata
-- Purpose: Activate database-driven orchestrations for workflow follow-up workflows (Plan.md §4.3, §5.7)
-- Strategy: Upsert provider response mappings, operation templates, workflow templates, and steps

BEGIN;

ALTER TABLE workflow_templates
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE workflow_templates
SET updated_at = COALESCE(updated_at, created_at);

ALTER TABLE workflow_templates
    ALTER COLUMN updated_at SET NOT NULL,
    ALTER COLUMN updated_at SET DEFAULT now();

WITH logestechs_provider AS (
    SELECT
        id,
        COALESCE(metadata->>'base_url', 'https://apisv2.logestechs.com') AS base_url
    FROM providers
    WHERE name = 'logestechs_3pl'
    LIMIT 1
),
logestechs_auth AS (
    SELECT
        credentials->>'username' AS username,
        credentials->>'password' AS password
    FROM provider_auth_configs
    WHERE provider_id = (SELECT id FROM logestechs_provider)
    ORDER BY created_at DESC
    LIMIT 1
),
dialog_provider AS (
    SELECT
        id,
        COALESCE(metadata->>'base_url', 'https://waba-sandbox.360dialog.io') AS base_url
    FROM providers
    WHERE name = 'dialog360_whatsapp'
    LIMIT 1
),
dialog_auth AS (
    SELECT
        credentials->>'api_key' AS api_key
    FROM provider_auth_configs
    WHERE provider_id = (SELECT id FROM dialog_provider)
    ORDER BY created_at DESC
    LIMIT 1
),
logestechs_mapping AS (
    INSERT INTO mapping_configs (
        id,
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
    )
    VALUES (
        '99990000-0000-0000-0000-000000210001',
        'provider_response',
        'logestechs::create_shipment::v1',
        $${
            "success_path": "$.status",
            "success_values": ["SUCCESS", "OK"],
            "field_mappings": {
                "shipment_id": "$.data.shipmentId",
                "reference_id": "$.data.orderId",
                "status": "$.status",
                "message": "$.message"
            }
        }$$::jsonb,
        1,
        'Logestechs create shipment provider response mapping'
    )
    ON CONFLICT (id) DO UPDATE
        SET mapping_config = EXCLUDED.mapping_config,
            mapping_version = EXCLUDED.mapping_version,
            notes = EXCLUDED.notes,
            updated_at = now()
    RETURNING id
),
dialog_mapping AS (
    INSERT INTO mapping_configs (
        id,
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
    )
    VALUES (
        '99990000-0000-0000-0000-000000210002',
        'provider_response',
        'dialog360::send_whatsapp::v1',
        $${
            "success_path": "$.messages[0].id",
            "field_mappings": {
                "message_id": "$.messages[0].id",
                "status": "$.messages[0].status",
                "timestamp": "$.messages[0].timestamp"
            }
        }$$::jsonb,
        1,
        '360dialog WhatsApp send response mapping'
    )
    ON CONFLICT (id) DO UPDATE
        SET mapping_config = EXCLUDED.mapping_config,
            mapping_version = EXCLUDED.mapping_version,
            notes = EXCLUDED.notes,
            updated_at = now()
    RETURNING id
),
logestechs_operation AS (
    INSERT INTO operation_templates (
        id,
        provider_id,
        operation_name,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        timeout_seconds,
        idempotency_key_template
    )
    SELECT
        '99990000-0000-0000-0000-000000220001',
        lp.id,
        'logestechs_create_shipment_v1',
        'POST',
        lp.base_url || '/api/v2/shipments',
        jsonb_strip_nulls(jsonb_build_object(
            'content-type', 'application/json',
            'authorization',
                CASE
                    WHEN la.username IS NOT NULL AND la.password IS NOT NULL THEN
                        'Basic ' || encode(convert_to(la.username || ':' || la.password, 'UTF8'), 'base64')
                    ELSE NULL
                END
        )),
        '{}'::jsonb,
        $${
            "body": {
                "companyId": "$.provider_defaults.companyId",
                "serviceType": "$.payload.shipment.service_type",
                "shipmentType": "$.provider_defaults.shipmentType",
                "integrationSource": "$.provider_defaults.integrationSource",
                "senderName": "$.provider_defaults.senderName",
                "senderPhone": "$.provider_defaults.senderPhone",
                "receiverName": "$.payload.shipment.receiver_name",
                "receiverPhone": "$.payload.shipment.receiver_phone",
                "cod": "$.payload.shipment.cod",
                "description": "$.payload.shipment.description",
                "destinationVillage": "$.payload.shipment.destination_village",
                "packageItems": "$.payload.shipment.package_items",
                "packageTemplate": "$.provider_defaults.packageTemplate",
                "originTemplate": "$.provider_defaults.originTemplate",
                "destinationTemplate": "$.provider_defaults.destinationTemplate"
            },
            "headers": {
                "x-trace-id": "$.context.trace_id"
            }
        }$$::jsonb,
        (SELECT id FROM logestechs_mapping),
        45,
        NULL
    FROM logestechs_provider lp
    LEFT JOIN logestechs_auth la ON TRUE
    ON CONFLICT (provider_id, operation_name) DO UPDATE
        SET url_template = EXCLUDED.url_template,
            headers_template = EXCLUDED.headers_template,
            body_template = EXCLUDED.body_template,
            request_mappings = EXCLUDED.request_mappings,
            mapping_config_id = EXCLUDED.mapping_config_id,
            timeout_seconds = EXCLUDED.timeout_seconds,
            updated_at = now()
    RETURNING id
),
dialog_operation AS (
    INSERT INTO operation_templates (
        id,
        provider_id,
        operation_name,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        timeout_seconds,
        idempotency_key_template
    )
    SELECT
        '99990000-0000-0000-0000-000000220002',
        dp.id,
        'dialog360_send_whatsapp_status_v1',
        'POST',
        dp.base_url || '/v1/messages',
        jsonb_strip_nulls(jsonb_build_object(
            'content-type', 'application/json',
            'D360-API-KEY', da.api_key
        )),
        $${
            "messaging_product": "whatsapp",
            "type": "template"
        }$$::jsonb,
        $${
            "body": {
                "to": "$.payload.recipient.phone",
                "template": "$.payload.template",
                "language": "$.payload.language",
                "components": "$.payload.components"
            },
            "headers": {
                "X-Client-Id": "$.context.client_id"
            }
        }$$::jsonb,
        (SELECT id FROM dialog_mapping),
        30,
        NULL
    FROM dialog_provider dp
    LEFT JOIN dialog_auth da ON TRUE
    ON CONFLICT (provider_id, operation_name) DO UPDATE
        SET url_template = EXCLUDED.url_template,
            headers_template = EXCLUDED.headers_template,
            body_template = EXCLUDED.body_template,
            request_mappings = EXCLUDED.request_mappings,
            mapping_config_id = EXCLUDED.mapping_config_id,
            timeout_seconds = EXCLUDED.timeout_seconds,
            updated_at = now()
    RETURNING id
),
upsert_logestechs_workflow AS (
    INSERT INTO workflow_templates (
        id,
        name,
        description,
        version,
        status,
        scope_type,
        scope_id,
        notes
    )
    VALUES (
        '99990000-0000-0000-0000-000000300001',
        'logestechs_shipment_ack_v1',
        'Create shipment via Logestechs and notify customer through WhatsApp (Plan.md §5.7.1).',
        1,
        'active',
        'global',
        NULL,
        'Canonical logestechs shipment acknowledgement workflow'
    )
    ON CONFLICT (name) DO UPDATE
        SET description = EXCLUDED.description,
            status = 'active',
            scope_type = EXCLUDED.scope_type,
            scope_id = EXCLUDED.scope_id,
            notes = EXCLUDED.notes
    RETURNING id
),
upsert_async_workflow AS (
    INSERT INTO workflow_templates (
        id,
        name,
        description,
        version,
        status,
        scope_type,
        scope_id,
        notes
    )
    VALUES (
        '99990000-0000-0000-0000-000000300002',
        'async_provider_dispatch_v1',
        'Dispatch provider call asynchronously and register workflow audit (Plan.md §5.7.3).',
        1,
        'active',
        'global',
        NULL,
        'Canonical async provider workflow (single-step API call + audit)'
    )
    ON CONFLICT (name) DO UPDATE
        SET description = EXCLUDED.description,
            status = 'active',
            scope_type = EXCLUDED.scope_type,
            scope_id = EXCLUDED.scope_id,
            notes = EXCLUDED.notes
    RETURNING id
),
logestechs_template AS (
    SELECT id FROM upsert_logestechs_workflow
    UNION ALL
    SELECT id FROM workflow_templates WHERE name = 'logestechs_shipment_ack_v1'
    LIMIT 1
),
async_template AS (
    SELECT id FROM upsert_async_workflow
    UNION ALL
    SELECT id FROM workflow_templates WHERE name = 'async_provider_dispatch_v1'
    LIMIT 1
)
INSERT INTO workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    condition_jsonlogic,
    next_operation_name,
    next_operation_priority,
    next_operation_delay_seconds,
    manual_action_required,
    metadata
)
VALUES
    (
        '99990000-0000-0000-0000-000000310001',
        (SELECT id FROM logestechs_template),
        1,
        'call_supplier_api',
        'operation_template',
        'success',
        NULL,
        'generate_label_job',
        85,
        NULL,
        FALSE,
        jsonb_build_object(
            'operation_template_id', (SELECT id FROM logestechs_operation),
            'operation_name', 'logestechs_create_shipment_v1',
            'payload_path', '$.transformed_payload',
            'expects_provider_defaults', TRUE,
            'priority', 80,
            'max_retries', 3
        )
    ),
    (
        '99990000-0000-0000-0000-000000310006',
        (SELECT id FROM logestechs_template),
        2,
        'generate_label_job',
        'workflow',
        'always',
        NULL,
        'wait_for_label_job',
        70,
        NULL,
        FALSE,
        jsonb_build_object(
            'label_type', 'shipping',
            'job_purpose', 'primary',
            'requested_source', 'workflow.logestechs',
            'max_retries', 1
        )
    ),
    (
        '99990000-0000-0000-0000-000000310007',
        (SELECT id FROM logestechs_template),
        3,
        'wait_for_label_job',
        'workflow',
        'always',
        NULL,
        'enqueue_notification',
        65,
        NULL,
        FALSE,
        jsonb_build_object(
            'poll_interval_seconds', 30,
            'max_wait_seconds', 900,
            'max_retries', 60
        )
    ),
    (
        '99990000-0000-0000-0000-000000310002',
        (SELECT id FROM logestechs_template),
        4,
        'enqueue_notification',
        'operation_template',
        'success',
        NULL,
        'record_workflow_completion',
        60,
        NULL,
        FALSE,
        jsonb_build_object(
            'operation_template_id', (SELECT id FROM dialog_operation),
            'operation_name', 'dialog360_send_whatsapp_status_v1',
            'payload_path', '$.transformed_payload',
            'notification_template', 'shipment_created_notification',
            'priority', 60,
            'max_retries', 2
        )
    ),
    (
        '99990000-0000-0000-0000-000000310003',
        (SELECT id FROM logestechs_template),
        5,
        'record_workflow_completion',
        'workflow',
        'always',
        NULL,
        NULL,
        NULL,
        NULL,
        FALSE,
        jsonb_build_object(
            'status', 'completed'
        )
    ),
    (
        '99990000-0000-0000-0000-000000310004',
        (SELECT id FROM async_template),
        1,
        'call_supplier_api',
        'operation_template',
        'always',
        NULL,
        'record_workflow_completion',
        70,
        NULL,
        FALSE,
        jsonb_build_object(
            'operation_template_id', (SELECT id FROM logestechs_operation),
            'operation_name', 'logestechs_create_shipment_v1',
            'payload_path', '$.transformed_payload',
            'expects_provider_defaults', TRUE,
            'priority', 70,
            'max_retries', 3
        )
    ),
    (
        '99990000-0000-0000-0000-000000310005',
        (SELECT id FROM async_template),
        2,
        'record_workflow_completion',
        'workflow',
        'always',
        NULL,
        NULL,
        NULL,
        NULL,
        FALSE,
        jsonb_build_object(
            'status', 'completed'
        )
    )
ON CONFLICT (id) DO UPDATE
    SET operation_name = EXCLUDED.operation_name,
        operation_settings_category = EXCLUDED.operation_settings_category,
        transition_condition = EXCLUDED.transition_condition,
        condition_jsonlogic = EXCLUDED.condition_jsonlogic,
        next_operation_name = EXCLUDED.next_operation_name,
        next_operation_priority = EXCLUDED.next_operation_priority,
        next_operation_delay_seconds = EXCLUDED.next_operation_delay_seconds,
        manual_action_required = EXCLUDED.manual_action_required,
        metadata = EXCLUDED.metadata,
        updated_at = now();

WITH logestechs_template AS (
    SELECT id FROM workflow_templates WHERE name = 'logestechs_shipment_ack_v1' LIMIT 1
),
async_template AS (
    SELECT id FROM workflow_templates WHERE name = 'async_provider_dispatch_v1' LIMIT 1
),
checksums AS (
    SELECT
        workflow_template_id,
        md5(
            string_agg(
                concat_ws(
                    '|',
                    sequence_order,
                    operation_name,
                    COALESCE(next_operation_name, ''),
                    COALESCE(operation_settings_category, ''),
                    COALESCE(transition_condition, ''),
                    COALESCE(metadata::text, '')
                ),
                '||' ORDER BY sequence_order
            )
        ) AS checksum
    FROM workflow_template_steps
    WHERE workflow_template_id IN (
        (SELECT id FROM logestechs_template),
        (SELECT id FROM async_template)
    )
    GROUP BY workflow_template_id
)
UPDATE workflow_templates wt
SET steps_checksum = checksums.checksum,
    status = 'active',
    published_at = COALESCE(wt.published_at, now()),
    updated_at = now()
FROM checksums
WHERE wt.id = checksums.workflow_template_id;

COMMIT;

