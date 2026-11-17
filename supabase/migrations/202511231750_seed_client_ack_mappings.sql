-- Migration: webhook ACK mapping templates
-- Purpose:
--   - Keep canonical reusable response mapping templates in active migrations.
--   - Per-client fixture assignments are retired from active migrations and belong
--     in non-production bootstrap scripts.

BEGIN;

SET search_path TO public, pg_temp;

INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
VALUES
    (
        '99990000-0000-0000-0000-000000400001',
        'webhook_response',
        'client_ack::logestechs_v1',
        '{
            "status_code": 200,
            "headers": {
                "content-type": "application/json",
                "x-client-ack": "logestechs"
            },
            "body": {
                "status": "accepted",
                "resource_id": "{{ resource.id }}",
                "tracking_number": "{{ resource.tracking_number }}",
                "workflow_run_id": "{{ workflow_run_id }}"
            }
        }'::jsonb,
        1,
        'Per-client ACK body for Logestechs Automation Client 2'
    ),
    (
        '99990000-0000-0000-0000-000000400002',
        'webhook_response',
        'client_ack::jarad_v1',
        '{
            "status_code": 200,
            "headers": {
                "content-type": "application/json",
                "x-client-ack": "jarad"
            },
            "body": {
                "status": "accepted",
                "correlation_id": "{{ webhook.correlation_id }}",
                "tracking_summary": "{{ resource.tracking_number }}",
                "ack_version": "jarad.v1"
            }
        }'::jsonb,
        1,
        'Per-client ACK body for جراد LLC'
    )
ON CONFLICT (id) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    mapping_version = EXCLUDED.mapping_version,
    notes = EXCLUDED.notes,
    updated_at = now();

COMMIT;
