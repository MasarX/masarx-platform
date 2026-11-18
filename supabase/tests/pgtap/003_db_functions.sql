-- Test Suite: Core DB Functions (claim_pending_jobs, get_job_call_spec, workflow progression)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

-- Fixtures --------------------------------------------------------------------
-- This fixture owns client/sender setup. Defer organization bootstrap until
-- the source-binding context exists, then run canonical onboarding explicitly.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
INSERT INTO organizations (id, name, slug)
VALUES ('aaaa0000-0000-0000-0000-000000000002', 'Function Org', 'function-org')
ON CONFLICT (id) DO NOTHING;
SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO clients (id, organization_id, name, slug, status)
VALUES ('bbbb0000-0000-0000-0000-000000000002', 'aaaa0000-0000-0000-0000-000000000002', 'Function Client', 'function-client', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
VALUES (
    'bbbb0000-0000-0000-0000-000000000102',
    'bbbb0000-0000-0000-0000-000000000002',
    'Function Sender',
    'Function Sender',
    FALSE,
    TRUE,
    'active'
) ON CONFLICT (id) DO NOTHING;

SELECT public.bootstrap_tenant_onboarding_v1(
    'aaaa0000-0000-0000-0000-000000000002',
    'pgtap:db-functions-fixture-bootstrap'
);

INSERT INTO providers (id, organization_id, name, provider_type)
VALUES ('cccc0000-0000-0000-0000-000000000002', 'aaaa0000-0000-0000-0000-000000000002', 'Function Provider', 'http')
ON CONFLICT (id) DO NOTHING;

INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config)
VALUES (
    '99990000-0000-0000-0000-000000000002',
    'webhook_inbound',
    'function-source::default',
    '{"field_mappings": {"example": "$.example"}}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO webhook_sources (id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id)
VALUES (
    'dddd0000-0000-0000-0000-000000000002',
    'aaaa0000-0000-0000-0000-000000000002',
    'function-source',
    'Function Source',
    'provider',
    'token',
    '99990000-0000-0000-0000-000000000002'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO webhook_inbox (
    id,
    webhook_source_id,
    provider_type,
    raw_payload,
    processing_status,
    correlation_id,
    created_at
) VALUES (
    'eeee0000-0000-0000-0000-000000000002',
    'dddd0000-0000-0000-0000-000000000002',
    'provider',
    '{"example": "payload"}',
    'pending',
    gen_random_uuid(),
    now()
) ON CONFLICT (id) DO NOTHING;

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'cccc2222-0000-0000-0000-000000000002', true);
INSERT INTO workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type
)
VALUES (
    'aaaa2222-0000-0000-0000-000000000002',
    'Function Outbound Template',
    'Fixture workflow for outbound guard context',
    1,
    'active',
    'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    handler_key,
    handler_version,
    enabled
)
VALUES (
    'bbbb2222-0000-0000-0000-000000000002',
    'aaaa2222-0000-0000-0000-000000000002',
    1,
    'workflow_control',
    'always',
    'workflow_control',
    'v1',
    TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
)
VALUES (
    'cccc2222-0000-0000-0000-000000000002',
    'aaaa2222-0000-0000-0000-000000000002',
    1,
    'test',
    'pending',
    '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
    id,
    workflow_run_id,
    workflow_template_step_id,
    sequence_order,
    step_status,
    operation_name,
    handler_key,
    handler_version,
    max_retries,
    enqueued_at,
    created_at,
    updated_at
)
VALUES (
    'dddd2222-0000-0000-0000-000000000002',
    'cccc2222-0000-0000-0000-000000000002',
    'bbbb2222-0000-0000-0000-000000000002',
    1,
    'pending',
    'workflow_control',
    'workflow_control',
    'v1',
    1,
    now(),
    now(),
    now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', 'dddd2222-0000-0000-0000-000000000002', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'dddd2222-0000-0000-0000-000000000002', true);

INSERT INTO outbound_calls (
    id,
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    status,
    priority,
    retry_count,
    max_retries,
    scheduled_at,
    created_at,
    workflow_run_step_id
) VALUES (
    'ffff0000-0000-0000-0000-000000000002',
    'provider_api',
    'provider',
    'cccc0000-0000-0000-0000-000000000002',
    'POST',
    'https://example.test',
    '{"Content-Type": "application/json"}'::jsonb,
    '{"hello": "world"}'::jsonb,
    'pending',
    100,
    0,
    1,
    now(),
    now(),
    'dddd2222-0000-0000-0000-000000000002'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    created_at
) VALUES (
    'aaaa1111-0000-0000-0000-000000000002',
    'Test Workflow',
    'Fixture workflow for resolve_workflow_steps',
    1,
    'active',
    'tenant',
    'aaaa0000-0000-0000-0000-000000000002',
    now()
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
    manual_action_required,
    enabled
) VALUES (
    'bbbb1111-0000-0000-0000-000000000002',
    'aaaa1111-0000-0000-0000-000000000002',
    1,
    'noop_operation',
    'workflow',
    'always',
    'workflow_control',
    'v1',
    jsonb_build_object('action', 'noop'),
    FALSE,
    TRUE
) ON CONFLICT (id) DO NOTHING;

-- Tests -----------------------------------------------------------------------

SELECT isnt_empty(
    $$ SELECT * FROM claim_pending_jobs(5) $$,
    'claim_pending_jobs returns pending job'
);

UPDATE outbound_calls SET lease_expires_at = NULL WHERE id = 'ffff0000-0000-0000-0000-000000000002';

SELECT is(
    (get_job_call_spec('ffff0000-0000-0000-0000-000000000002') ->> 'url'),
    'https://example.test',
    'get_job_call_spec returns job URL'
);

SELECT isnt_empty(
    $$ SELECT resolve_workflow_steps(id) FROM workflow_templates LIMIT 1 $$,
    'resolve_workflow_steps returns enabled steps when available'
);

SELECT is(
    (plan_retry_strategy(gen_random_uuid(), '{}'::jsonb)->>'retry_allowed')::BOOLEAN,
    TRUE,
    'plan_retry_strategy returns retry metadata'
);

SELECT is(
    (select_fallback_operation(gen_random_uuid(), '{}'::jsonb)),
    NULL::UUID,
    'select_fallback_operation returns NULL placeholder'
);

-- Extent helper coverage ----------------------------------------------------

CREATE TEMP TABLE extent_fixture (
    id SERIAL,
    geom geometry(Point, 4326)
);

INSERT INTO extent_fixture (geom)
SELECT ST_SetSRID(ST_MakePoint(lon, lat), 4326)
FROM (VALUES
    (46.6753, 24.7136),
    (46.6200, 24.8000)
) AS coords(lon, lat);

SELECT is(
    public.find_extent('pg_temp.extent_fixture'::regclass, 'geom')::TEXT,
    (SELECT ST_Extent(geom)::TEXT FROM extent_fixture),
    'find_extent computes ST_Extent for regclass input'
);

SELECT finish();

ROLLBACK;
