-- pgTAP: public.test_integration_plugin_v1 contract (allowed/denied/audit/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := '00000000-0000-4000-8000-000000009920';
  v_ops UUID := '00000000-0000-4000-8000-000000009921';
  v_sender UUID := '00000000-0000-4000-8000-000000009922';
  v_client UUID := '00000000-0000-4000-8000-000000009923';
  v_sender_scope UUID := '00000000-0000-4000-8000-000000009924';
  v_plugin UUID := gen_random_uuid();
  v_version UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W9-2 Plugin Test Org', 'w9-2-pl-test-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'W9-2 Plugin Test Client', 'w9-2-pl-client-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender_scope, v_client, 'W9-2 Plugin Test Sender', 'W9-2 Plugin Test Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w9-2-ops-' || left(v_ops::text, 8) || '@example.com',
     'W9-2 Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'w9-2-sender-' || left(v_sender::text, 8) || '@example.com',
     'W9-2 Sender', 'sender_user', 'sender', v_sender_scope)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.integration_plugins (
    id, organization_id, plugin_key, name, plugin_kind, status, rollout_tier
  ) VALUES (
    v_plugin, v_org, 'w9-2-plugin-' || left(v_plugin::text, 8),
    'W9-2 Test Plugin', 'webhook', 'draft', 'standard'
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.integration_plugin_versions (
    id, plugin_id, organization_id, version_no, status, source_type,
    inbound_config, mapping_config, workflow_binding
  ) VALUES (
    v_version, v_plugin, v_org, 1, 'draft', 'manual',
    '{"webhook":{"signature_required":true,"name":"w9-2-src"}}'::jsonb,
    '{"steps":[{"from":"foo","to":"bar"}]}'::jsonb,
    '{"template_name":"shipment_create_v1"}'::jsonb
  ) ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w9_2_org', v_org::text, true);
  PERFORM set_config('test.w9_2_ops', v_ops::text, true);
  PERFORM set_config('test.w9_2_sender', v_sender::text, true);
  PERFORM set_config('test.w9_2_plugin', v_plugin::text, true);
  PERFORM set_config('test.w9_2_version', v_version::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can run plugin test by plugin_id.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w9_2_ops'), true);
SET LOCAL ROLE authenticated;
WITH tested AS (
  SELECT public.test_integration_plugin_v1(jsonb_build_object(
    'plugin_id', current_setting('test.w9_2_plugin'),
    'payload', '{"sample":"payload"}'::jsonb
  )) AS result
)
SELECT ok(
  result->'ok' = 'true'::jsonb AND result#>'{steps,0,signature_required}' = 'true'::jsonb,
  'ops_admin can test a plugin and read back its non-secret signature requirement'
)
FROM tested;
RESET ROLE;

-- 2) Allowed: ops_admin can target the exact plugin_version_id without active-version fallback.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w9_2_ops'), true);
SET LOCAL ROLE authenticated;
SELECT is(
  (
    SELECT public.test_integration_plugin_v1(jsonb_build_object(
      'plugin_version_id', current_setting('test.w9_2_version'),
      'payload', '{"sample":"version-targeted"}'::jsonb
    ))->>'plugin_version_id'
  ),
  current_setting('test.w9_2_version'),
  'test_integration_plugin_v1 accepts explicit plugin_version_id and returns the same version'
);
RESET ROLE;

-- 3) Denied: sender_user lacks integration_plugins.test.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w9_2_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.test_integration_plugin_v1(jsonb_build_object(
       'plugin_id', current_setting('test.w9_2_plugin')
     )) $$,
  '42501',
  NULL,
  'sender_user denied test_integration_plugin_v1'
);
RESET ROLE;

-- 4) Persisted: validation_runs row written with run_type='test'.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.integration_plugin_validation_runs
     WHERE plugin_version_id = current_setting('test.w9_2_version')::uuid
       AND run_type = 'test'
       AND status = 'succeeded'
  ),
  'test_integration_plugin_v1 wrote integration_plugin_validation_runs row (run_type=test)'
);

-- 5) Missing required arg: 23502.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w9_2_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.test_integration_plugin_v1('{}'::jsonb) $$,
  '23502',
  NULL,
  'test_integration_plugin_v1 raises 23502 when neither plugin_id nor plugin_version_id provided'
);
RESET ROLE;

-- 6) Decision_log audit row written.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE resource_id = current_setting('test.w9_2_version')::uuid
       AND decision_category = 'integration_plugin.test'
       AND decision_outcome = 'test_succeeded'
  ),
  'test_integration_plugin_v1 wrote decision_log audit row'
);

SELECT * FROM finish();
ROLLBACK;
