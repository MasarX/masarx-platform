-- Test Suite: Operation template call_type enforcement

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- This fixture owns client/sender setup. Defer organization bootstrap until
-- the source-binding context exists, then run canonical onboarding explicitly.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
INSERT INTO organizations (id, name, slug)
VALUES ('aaaa8000-0000-0000-0000-000000000010', 'Call Type Org', 'call-type-org')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    updated_at = now();
SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO clients (id, organization_id, name, slug, status)
VALUES (
    'bbbb8000-0000-0000-0000-000000000110',
    'aaaa8000-0000-0000-0000-000000000010',
    'Call Type Client',
    'call-type-client',
    'active'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
    'bbbb8000-0000-0000-0000-000000000210',
    'bbbb8000-0000-0000-0000-000000000110',
    'Call Type Sender',
    'Call Type Sender',
    false,
    true,
    'active'
)
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    name = EXCLUDED.name,
    brand_name = EXCLUDED.brand_name,
    status = EXCLUDED.status,
    updated_at = now();

SELECT public.bootstrap_tenant_onboarding_v1(
    'aaaa8000-0000-0000-0000-000000000010',
    'pgtap:operation-templates-call-type-fixture-bootstrap'
);

INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config)
VALUES (
    '99990000-0000-0000-0000-000000330001',
    'provider_response',
    'call-type::default',
    '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO providers (id, organization_id, name, provider_type, metadata)
VALUES (
    'bbbb8000-0000-0000-0000-000000000010',
    'aaaa8000-0000-0000-0000-000000000010',
    'Call Type WhatsApp',
    'comms',
    jsonb_build_object('channel', 'whatsapp', 'base_url', 'https://example.whatsapp.test')
) ON CONFLICT (id) DO NOTHING;

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
    call_type,
    timeout_seconds,
    idempotency_key_template,
    handler_key,
    handler_version
) VALUES (
    'cccc8000-0000-0000-0000-000000000010',
    'bbbb8000-0000-0000-0000-000000000010',
    'call_type_send_whatsapp_v1',
    'POST',
    'https://example.whatsapp.test/v1/messages',
    '{"content-type": "application/json"}'::jsonb,
    '{}'::jsonb,
    '{"body": {"to": "$.payload.to"}}'::jsonb,
    '99990000-0000-0000-0000-000000330001',
    'comms_whatsapp',
    30,
    NULL,
    'outbound_http',
    'v1'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id
) VALUES (
    'dddd8000-0000-0000-0000-000000000010',
    'call_type_workflow',
    'Workflow for verifying call_type propagation',
    1,
    'active',
    'tenant',
    'aaaa8000-0000-0000-0000-000000000010'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    enabled
) VALUES (
    'eeee8000-0000-0000-0000-000000000010',
    'dddd8000-0000-0000-0000-000000000010',
    1,
    'call_type_send_whatsapp_v1',
    'operation_template',
    'always',
    'outbound_http',
    'v1',
    jsonb_build_object('operation_template_id', 'cccc8000-0000-0000-0000-000000000010'),
    TRUE
) ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'ffff8000-0000-0000-0000-000000000010', true);
INSERT INTO workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    workflow_status,
    context,
    entry_point
) VALUES (
    'ffff8000-0000-0000-0000-000000000010',
    'dddd8000-0000-0000-0000-000000000010',
    1,
    'pending',
    jsonb_build_object('transformed_payload', jsonb_build_object('payload', jsonb_build_object('to', '+12025550123')), 'correlation_id', gen_random_uuid()),
    'webhook'
) ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'ffff8000-0000-0000-0000-000000000010', true);
INSERT INTO workflow_run_steps (
    id,
    workflow_run_id,
    workflow_template_step_id,
    sequence_order,
    step_status,
    operation_name,
    metadata,
    max_retries,
    handler_key,
    handler_version
) VALUES (
    '11118000-0000-0000-0000-000000000010',
    'ffff8000-0000-0000-0000-000000000010',
    'eeee8000-0000-0000-0000-000000000010',
    1,
    'pending',
    'call_type_send_whatsapp_v1',
    jsonb_build_object('operation_template_id', 'cccc8000-0000-0000-0000-000000000010'),
    3,
    'outbound_http',
    'v1'
) ON CONFLICT (id) DO NOTHING;

SELECT is(
    (SELECT call_type FROM operation_templates WHERE id = 'cccc8000-0000-0000-0000-000000000010'),
    'comms_whatsapp',
    'Operation template stores explicit call_type'
);

SELECT set_config('app.workflow_run_step_id', '11118000-0000-0000-0000-000000000010', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', '11118000-0000-0000-0000-000000000010', true);

SELECT workflow_handlers.execute_outbound_http_v1(
    (SELECT wrs FROM workflow_run_steps wrs WHERE wrs.id = '11118000-0000-0000-0000-000000000010'),
    (SELECT wr FROM workflow_runs wr WHERE wr.id = 'ffff8000-0000-0000-0000-000000000010'),
    '{}'::jsonb
);

SELECT is(
    (SELECT call_type FROM outbound_calls WHERE workflow_run_step_id = '11118000-0000-0000-0000-000000000010' ORDER BY created_at DESC LIMIT 1),
    'comms_whatsapp',
    'Outbound job inherits call_type from operation template'
);

SELECT * FROM finish();

ROLLBACK;
