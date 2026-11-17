-- Test Suite: Webhook intake single pipeline

BEGIN;

SET LOCAL search_path TO public, extensions, pg_temp;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT '1..10';

SELECT CASE
    WHEN has_function_privilege('edge_webhook_role', 'public.workflow_intake_webhook(text, jsonb, text, jsonb)', 'EXECUTE')
        THEN 'ok 1 - edge_webhook_role can execute workflow_intake_webhook'
    ELSE 'not ok 1 - edge_webhook_role can execute workflow_intake_webhook' || E'\n# edge_webhook_role missing EXECUTE on workflow_intake_webhook'
END;

INSERT INTO organizations (id, name, slug)
VALUES ('aaaa1000-0000-0000-0000-000000000004', 'Webhook Org', 'webhook-org')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    updated_at = now();

INSERT INTO mapping_configs (
    id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes
) VALUES (
    'cccc1000-0000-0000-0000-000000000004',
    'webhook_inbound',
    'webhook-test::default',
    '{}'::jsonb,
    1,
    'Minimal mapping for webhook intake pgTAP suite'
) ON CONFLICT (id) DO UPDATE
SET mapping_type = EXCLUDED.mapping_type,
    mapping_key = EXCLUDED.mapping_key,
    mapping_config = EXCLUDED.mapping_config,
    mapping_version = EXCLUDED.mapping_version,
    notes = EXCLUDED.notes,
    updated_at = now();

INSERT INTO workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id
) VALUES (
    'ffff1000-0000-0000-0000-000000000004',
    'webhook_followup_v1',
    'Follow-up workflow for webhook intake tests',
    1,
    'active',
    'tenant',
    'aaaa1000-0000-0000-0000-000000000004'
) ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    version = EXCLUDED.version,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    updated_at = now();

INSERT INTO webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    enabled
) VALUES (
    'bbbb1000-0000-0000-0000-000000000004',
    'aaaa1000-0000-0000-0000-000000000004',
    'webhook-test',
    'Webhook Test Source',
    'provider',
    'token-webhook-test',
    'cccc1000-0000-0000-0000-000000000004',
    TRUE
) ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    source_identifier = EXCLUDED.source_identifier,
    name = EXCLUDED.name,
    provider_type = EXCLUDED.provider_type,
    auth_token = EXCLUDED.auth_token,
    mapping_config_id = EXCLUDED.mapping_config_id,
    enabled = TRUE,
    updated_at = now();

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
) VALUES (
    'aaaa2000-0000-0000-0000-000000000004',
    'webhook_ingest_policy',
    'source',
    'bbbb1000-0000-0000-0000-000000000004',
    1,
    jsonb_build_object(
        'version', 1,
        'ack', jsonb_build_object(
            'mode', 'accepted_async',
            'default_headers', jsonb_build_object('cache-control', 'no-store')
        ),
        'workflow', jsonb_build_object(
            'template_id', 'ffff1000-0000-0000-0000-000000000004'
        )
    ),
    1,
    'Test webhook intake policy',
    now(),
    now()
)
ON CONFLICT ON CONSTRAINT settings_versions_new_pkey DO UPDATE
SET value = EXCLUDED.value,
    schema_version = EXCLUDED.schema_version,
    change_reason = EXCLUDED.change_reason,
    approved_at = EXCLUDED.approved_at,
    effective_from = EXCLUDED.effective_from,
    effective_until = NULL,
    created_at = now();

INSERT INTO settings (
    id,
    category,
    scope_type,
    scope_id,
    settings_version_id,
    cached_value,
    last_updated
) VALUES (
    'aaaa3000-0000-0000-0000-000000000004',
    'webhook_ingest_policy',
    'source',
    'bbbb1000-0000-0000-0000-000000000004',
    'aaaa2000-0000-0000-0000-000000000004',
    jsonb_build_object(
        'version', 1,
        'ack', jsonb_build_object(
            'mode', 'accepted_async',
            'default_headers', jsonb_build_object('cache-control', 'no-store')
        ),
        'workflow', jsonb_build_object(
            'template_id', 'ffff1000-0000-0000-0000-000000000004'
        )
    ),
    now()
)
ON CONFLICT (category, scope_type, scope_id) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

SELECT CASE
    WHEN (workflow_intake_webhook(NULL, '{}'::jsonb, '', '{}'::jsonb)->>'status')::INT = 401
        THEN 'ok 2 - Missing bearer token returns 401'
    ELSE 'not ok 2 - Missing bearer token returns 401' || E'\n# expected status 401 for missing token'
END;

CREATE TEMP TABLE tmp_webhook_response AS
SELECT workflow_intake_webhook(
    'token-webhook-test',
    jsonb_build_object('content-type', 'application/json'),
    '{"event":{"id":"evt-pgtap-004-webhook-intake","type":"shipment.create"},"example":"value"}',
    jsonb_build_object(
        'event',
        jsonb_build_object(
            'id', 'evt-pgtap-004-webhook-intake',
            'type', 'shipment.create'
        ),
        'example', 'value'
    )
) AS response;

SELECT CASE
    WHEN (response->>'status')::INT = 202
        THEN 'ok 3 - Accepted async ack returns 202'
    ELSE 'not ok 3 - Accepted async ack returns 202' || E'\n# response status=''' || COALESCE(response->>'status', 'NULL') || ''''
END
FROM tmp_webhook_response;

SELECT CASE
    WHEN (response->>'webhook_id')::UUID IS NOT NULL
        THEN 'ok 4 - Webhook id returned'
    ELSE 'not ok 4 - Webhook id returned'
END
FROM tmp_webhook_response;

SELECT CASE
    WHEN EXISTS(
        SELECT 1
        FROM webhook_inbox wi
        WHERE wi.id = (response->>'webhook_id')::UUID
          AND wi.workflow_run_id = (response->>'workflow_run_id')::UUID
          AND wi.processing_status = 'in_progress'
    )
        THEN 'ok 5 - webhook_inbox linked to workflow run'
    ELSE 'not ok 5 - webhook_inbox linked to workflow run'
END
FROM tmp_webhook_response;

SELECT CASE
    WHEN EXISTS(SELECT 1 FROM workflow_runs WHERE id = (response->>'workflow_run_id')::UUID)
        THEN 'ok 6 - workflow run created'
    ELSE 'not ok 6 - workflow run created'
END
FROM tmp_webhook_response;

SELECT CASE
    WHEN EXISTS(
        SELECT 1
        FROM workflow_runs
        WHERE id = (response->>'workflow_run_id')::UUID
          AND workflow_template_id = '77770000-0000-0000-0000-000000770001'
    )
        THEN 'ok 7 - intake workflow run uses webhook_intake_v1 template'
    ELSE 'not ok 7 - intake workflow run uses webhook_intake_v1 template'
END
FROM tmp_webhook_response;

SELECT CASE
    WHEN (response->>'followup_workflow_run_id')::UUID IS NOT NULL
        THEN 'ok 8 - follow-up workflow run id returned'
    ELSE 'not ok 8 - follow-up workflow run id returned'
END
FROM tmp_webhook_response;

SELECT CASE
    WHEN EXISTS(
        SELECT 1
        FROM workflow_runs
        WHERE id = (response->>'followup_workflow_run_id')::UUID
          AND workflow_template_id = 'ffff1000-0000-0000-0000-000000000004'
    )
        THEN 'ok 9 - follow-up workflow run uses configured template'
    ELSE 'not ok 9 - follow-up workflow run uses configured template'
END
FROM tmp_webhook_response;

SELECT CASE
    WHEN EXISTS(
        SELECT 1
        FROM webhook_response_events
        WHERE webhook_inbox_id = (response->>'webhook_id')::UUID
    )
        THEN 'ok 10 - http response event recorded'
    ELSE 'not ok 10 - http response event recorded'
END
FROM tmp_webhook_response;

DROP TABLE tmp_webhook_response;

ROLLBACK;
