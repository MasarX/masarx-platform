BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(29);

-- Core tables and RLS posture.
SELECT has_table('public', 'integration_plugins', 'integration_plugins table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'integration_plugins'), 'RLS enabled on integration_plugins');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'integration_plugins'), 'integration_plugins has RLS policies');

SELECT has_table('public', 'integration_plugin_versions', 'integration_plugin_versions table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'integration_plugin_versions'), 'RLS enabled on integration_plugin_versions');

SELECT has_table('public', 'integration_plugin_bindings', 'integration_plugin_bindings table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'integration_plugin_bindings'), 'RLS enabled on integration_plugin_bindings');

SELECT has_table('public', 'integration_plugin_validation_runs', 'integration_plugin_validation_runs table exists');
SELECT has_table('public', 'integration_plugin_approval_events', 'integration_plugin_approval_events table exists');

-- Lifecycle RPC surface.
SELECT has_function('public', 'integration_plugin_generate_draft_v1', ARRAY['text','text','text','jsonb','jsonb','jsonb','jsonb','jsonb','uuid','text','text','uuid','jsonb'], 'generate_draft RPC exists');
SELECT has_function('public', 'integration_plugin_validate_v1', ARRAY['uuid','jsonb','boolean'], 'validate RPC exists');
SELECT has_function('public', 'integration_plugin_submit_v1', ARRAY['uuid','text'], 'submit RPC exists');
SELECT has_function('public', 'integration_plugin_approve_v1', ARRAY['uuid','text','text'], 'approve RPC exists');
SELECT has_function('public', 'integration_plugin_activate_v1', ARRAY['uuid','text','uuid','text'], 'activate RPC exists');
SELECT has_function('public', 'integration_plugin_rotate_credentials_v1', ARRAY['uuid','text','jsonb','timestamp with time zone','text'], 'rotate credentials RPC exists');
SELECT has_function('public', 'integration_plugin_export_handoff_v1', ARRAY['uuid','text'], 'export handoff RPC exists');
SELECT has_function('public', 'integration_plugin_rollback_v1', ARRAY['uuid','uuid','text'], 'rollback RPC exists');
SELECT has_function('public', 'integration_plugin_migrate_runtime_assets_v1', ARRAY['text','uuid','text','jsonb'], 'migration assistant RPC exists');
SELECT has_function('public', 'resolve_integration_plugin_egress_policy_for_job_v1', ARRAY['uuid'], 'egress resolver function exists');
SELECT has_function('api', 'resolve_integration_plugin_egress_policy_for_job_v1', ARRAY['uuid'], 'api wrapper for egress resolver exists');
SELECT has_function('api', 'integration_plugin_rollback_v1', ARRAY['uuid','uuid','text'], 'api wrapper for rollback RPC exists');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'safe_missing_behavior'
      AND lv.value = 'soft_fail'
      AND lv.retired_at IS NULL
  ),
  'safe_missing_behavior lookup includes soft_fail'
);

-- Seed org/provider/workflow fixtures for trigger + egress behavior checks.
INSERT INTO public.organizations (id, name, slug)
VALUES ('8e02a0e0-0000-4000-8000-000000000001', 'Integration Plugin Test Org', 'integration-plugin-test-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.providers (
  id,
  organization_id,
  name,
  provider_type,
  enabled,
  metadata
)
VALUES (
  '8e02a0e0-0000-4000-8000-000000000002',
  '8e02a0e0-0000-4000-8000-000000000001',
  'integration-plugin-test-provider',
  'webhook',
  TRUE,
  jsonb_build_object('managed_by', 'integration_plugin')
)
ON CONFLICT (id) DO UPDATE
SET metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id;

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  '8e02a0e0-0000-4000-8000-000000000003',
  'provider_response',
  'integration-plugin-pgtap-response-map',
  '{}'::jsonb,
  1,
  'integration plugin pgtap response mapping'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.operation_templates (
  id,
  provider_id,
  operation_name,
  handler_key,
  method,
  url_template,
  headers_template,
  body_template,
  request_mappings,
  mapping_config_id,
  timeout_seconds,
  call_type,
  metadata
)
VALUES (
  '8e02a0e0-0000-4000-8000-000000000004',
  '8e02a0e0-0000-4000-8000-000000000002',
  'integration_plugin_pgtap_operation',
  'outbound_http',
  'POST',
  'https://example.com/plugin',
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '8e02a0e0-0000-4000-8000-000000000003',
  30,
  'provider_api',
  jsonb_build_object('managed_by', 'integration_plugin')
)
ON CONFLICT (id) DO UPDATE
SET metadata = EXCLUDED.metadata,
    handler_key = EXCLUDED.handler_key,
    provider_id = EXCLUDED.provider_id,
    mapping_config_id = EXCLUDED.mapping_config_id;

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  '8e02a0e0-0000-4000-8000-000000000005',
  'integration_plugin_pgtap_template_v1',
  'Workflow template for integration plugin trigger tests',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

-- Studio-managed route pack must be scoped and workflow-only.
INSERT INTO public.api_route_packs (
  id,
  name,
  description,
  enabled,
  scope_type,
  scope_id,
  managed_by,
  managed_metadata
)
VALUES (
  '8e02a0e0-0000-4000-8000-000000000006',
  'integration-plugin-pgtap-pack',
  'Pack for integration plugin trigger tests',
  TRUE,
  'tenant',
  '8e02a0e0-0000-4000-8000-000000000001',
  'integration_plugin',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

SELECT throws_ok(
  $$
    INSERT INTO public.api_routes (
      id,
      pack_id,
      route_name,
      enabled,
      method,
      path_template,
      scope_type,
      scope_id,
      provider_id,
      upstream_method,
      upstream_path_template,
      policy,
      managed_by,
      managed_metadata
    ) VALUES (
      '8e02a0e0-0000-4000-8000-000000000007',
      '8e02a0e0-0000-4000-8000-000000000006',
      'plugin_route_missing_workflow',
      TRUE,
      'POST',
      '/integration-plugin-pgtap/missing-workflow',
      'tenant',
      '8e02a0e0-0000-4000-8000-000000000001',
      '8e02a0e0-0000-4000-8000-000000000002',
      'POST',
      '/integration-plugin-pgtap/missing-workflow',
      '{}'::jsonb,
      'integration_plugin',
      '{}'::jsonb
    )
  $$,
  'integration_plugin api routes must enable policy.workflow.enabled=true',
  'workflow.enabled is mandatory for integration_plugin api routes'
);

SELECT throws_ok(
  $$
    INSERT INTO public.api_routes (
      id,
      pack_id,
      route_name,
      enabled,
      method,
      path_template,
      scope_type,
      scope_id,
      provider_id,
      upstream_method,
      upstream_path_template,
      policy,
      managed_by,
      managed_metadata
    ) VALUES (
      '8e02a0e0-0000-4000-8000-000000000008',
      '8e02a0e0-0000-4000-8000-000000000006',
      'plugin_route_proxy_mode',
      TRUE,
      'POST',
      '/integration-plugin-pgtap/proxy-mode',
      'tenant',
      '8e02a0e0-0000-4000-8000-000000000001',
      '8e02a0e0-0000-4000-8000-000000000002',
      'POST',
      '/integration-plugin-pgtap/proxy-mode',
      jsonb_build_object(
        'workflow', jsonb_build_object('enabled', true, 'template_name', 'integration_plugin_pgtap_template_v1'),
        'delivery', jsonb_build_object('mode', 'proxy')
      ),
      'integration_plugin',
      '{}'::jsonb
    )
  $$,
  'integration_plugin api routes cannot use delivery.mode=proxy',
  'proxy delivery mode is blocked for integration_plugin routes'
);

INSERT INTO public.api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy,
  managed_by,
  managed_metadata
)
VALUES (
  '8e02a0e0-0000-4000-8000-000000000009',
  '8e02a0e0-0000-4000-8000-000000000006',
  'plugin_route_valid',
  TRUE,
  'POST',
  '/integration-plugin-pgtap/valid',
  'tenant',
  '8e02a0e0-0000-4000-8000-000000000001',
  '8e02a0e0-0000-4000-8000-000000000002',
  'POST',
  '/integration-plugin-pgtap/valid',
  jsonb_build_object(
    'workflow', jsonb_build_object('enabled', true, 'template_name', 'integration_plugin_pgtap_template_v1')
  ),
  'integration_plugin',
  '{}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET policy = EXCLUDED.policy,
    managed_by = EXCLUDED.managed_by,
    managed_metadata = EXCLUDED.managed_metadata;

SELECT is(
  (SELECT policy #>> '{delivery,mode}' FROM public.api_routes WHERE id = '8e02a0e0-0000-4000-8000-000000000009'),
  'accepted_async',
  'integration_plugin route delivery.mode defaults to accepted_async'
);

SELECT is(
  (SELECT (policy #>> '{delivery,status_code}')::int FROM public.api_routes WHERE id = '8e02a0e0-0000-4000-8000-000000000009'),
  202,
  'integration_plugin route delivery.status_code defaults to 202'
);

-- Egress policy resolver should enforce integration_plugin-managed outbound jobs.
SELECT set_config('app.workflow_run_id', '8e02a0e0-0000-4000-8000-00000000000a', true);
SELECT set_config('platform.workflow_run_id', '8e02a0e0-0000-4000-8000-00000000000a', true);

INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  '8e02a0e0-0000-4000-8000-00000000000a',
  '8e02a0e0-0000-4000-8000-000000000005',
  1,
  'pgtap',
  'pending',
  '{}'::jsonb
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
  '8e02a0e0-0000-4000-8000-00000000000b',
  '8e02a0e0-0000-4000-8000-000000000005',
  1,
  'workflow_control',
  'always',
  'workflow_control',
  'v1',
  TRUE
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
  '8e02a0e0-0000-4000-8000-00000000000c',
  '8e02a0e0-0000-4000-8000-00000000000a',
  '8e02a0e0-0000-4000-8000-00000000000b',
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

SELECT set_config('app.workflow_run_step_id', '8e02a0e0-0000-4000-8000-00000000000c', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', '8e02a0e0-0000-4000-8000-00000000000c', true);

INSERT INTO public.outbound_calls (
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
  context
)
VALUES (
  '8e02a0e0-0000-4000-8000-00000000000d',
  'provider_api',
  'provider',
  '8e02a0e0-0000-4000-8000-000000000002',
  'POST',
  'https://api.example.com/plugin',
  '{}'::jsonb,
  '{}'::jsonb,
  'pending_edge',
  100,
  0,
  1,
  now(),
  now(),
  jsonb_build_object('operation_template_id', '8e02a0e0-0000-4000-8000-000000000004')
)
ON CONFLICT (id) DO UPDATE
SET context = EXCLUDED.context,
    target_id = EXCLUDED.target_id,
    status = EXCLUDED.status,
    scheduled_at = EXCLUDED.scheduled_at,
    lease_expires_at = NULL;

SELECT is(
  (public.resolve_integration_plugin_egress_policy_for_job_v1('8e02a0e0-0000-4000-8000-00000000000d')->>'enforce')::boolean,
  TRUE,
  'egress policy resolver enforces integration_plugin managed outbound job'
);

SELECT is(
  public.resolve_integration_plugin_egress_policy_for_job_v1('8e02a0e0-0000-4000-8000-00000000000d')->>'managed_by',
  'integration_plugin',
  'egress policy resolver reports managed_by=integration_plugin'
);

SELECT ok(
  (public.resolve_integration_plugin_egress_policy_for_job_v1('8e02a0e0-0000-4000-8000-00000000000d')->'policy') ? 'max_timeout_seconds',
  'egress policy resolver returns effective policy payload'
);

SELECT finish();

ROLLBACK;
