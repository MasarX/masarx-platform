-- pgTAP: public/api ui_archive_webhook_source_v1 contract.
-- Source archive is soft: row remains, enabled=false gates runtime intake, and
-- managed_metadata + ledgers preserve operator lineage.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

SELECT has_function(
  'public',
  'ui_archive_webhook_source_v1',
  ARRAY['jsonb'],
  'public.ui_archive_webhook_source_v1(jsonb) exists'
);

SELECT has_function(
  'api',
  'ui_archive_webhook_source_v1',
  ARRAY['jsonb'],
  'api.ui_archive_webhook_source_v1(jsonb) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_archive_webhook_source_v1(jsonb)'::regprocedure, 'EXECUTE'),
  'authenticated can execute api.ui_archive_webhook_source_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_archive_webhook_source_v1(jsonb)'::regprocedure, 'EXECUTE'),
  'anon cannot execute api.ui_archive_webhook_source_v1'
);

DO $$
DECLARE
  v_org_a UUID := '00000000-0000-0000-0000-00000000ba20';
  v_org_b UUID := '00000000-0000-0000-0000-00000000ba21';
  v_ops_a UUID := '00000000-0000-0000-0000-00000000ba22';
  v_ops_b UUID := '00000000-0000-0000-0000-00000000ba23';
  v_driver_a UUID := '00000000-0000-0000-0000-00000000ba24';
  v_mapping UUID := '00000000-0000-0000-0000-00000000ba25';
  v_source UUID := '00000000-0000-0000-0000-00000000ba26';
  v_drift_source UUID := '00000000-0000-0000-0000-00000000ba27';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org_a, 'B6 WS Archive Org A', 'b6-ws-archive-org-a'),
    (v_org_b, 'B6 WS Archive Org B', 'b6-ws-archive-org-b')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops_a, v_org_a, 'b6-ws-archive-a@example.test', 'B6 WS Archive Ops A', 'ops_admin', 'tenant', NULL),
    (v_ops_b, v_org_b, 'b6-ws-archive-b@example.test', 'B6 WS Archive Ops B', 'ops_admin', 'tenant', NULL),
    (v_driver_a, v_org_a, 'b6-ws-archive-driver@example.test', 'B6 WS Archive Driver A', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'b6-ws-archive::default', '{}'::jsonb, 1, 'B6 WS Archive pgTAP mapping')
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM public.webhook_sources WHERE id IN (v_source, v_drift_source);

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled, managed_metadata
  )
  VALUES (
    v_source, v_org_a, 'b6-ws-archive-source', 'B6 WS Archive Source', 'generic',
    'b6-ws-archive-token-' || left(v_source::text, 8), v_mapping, 100, TRUE, '{}'::jsonb
  );

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled, managed_metadata
  )
  VALUES (
    v_drift_source, v_org_a, 'b6-ws-archive-drift-source', 'B6 WS Archive Drift Source', 'generic',
    'b6-ws-archive-token-' || left(v_drift_source::text, 8), v_mapping, 100, TRUE,
    jsonb_build_object('lifecycle', 'archived', 'archived_at', now() - interval '1 hour')
  );

  PERFORM set_config('test.b6_ws_archive_source', v_source::text, true);
  PERFORM set_config('test.b6_ws_archive_drift_source', v_drift_source::text, true);
  PERFORM set_config('test.b6_ws_archive_ops_a', v_ops_a::text, true);
  PERFORM set_config('test.b6_ws_archive_ops_b', v_ops_b::text, true);
  PERFORM set_config('test.b6_ws_archive_driver_a', v_driver_a::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_archive_ops_a'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_archive_webhook_source_v1(jsonb_build_object(
      'source_id', current_setting('test.b6_ws_archive_source'),
      'reason', 'Legacy integration retired'
    ))->>'ok')::bool
  ),
  'ops_admin can archive webhook source through api wrapper'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.webhook_sources
     WHERE id = current_setting('test.b6_ws_archive_source')::uuid
  ),
  'archive preserves webhook_sources row'
);

SELECT is(
  (
    SELECT enabled::text
      FROM public.webhook_sources
     WHERE id = current_setting('test.b6_ws_archive_source')::uuid
  ),
  'false',
  'archive disables webhook source intake gate'
);

SELECT is(
  (
    SELECT managed_metadata->>'lifecycle'
      FROM public.webhook_sources
     WHERE id = current_setting('test.b6_ws_archive_source')::uuid
  ),
  'archived',
  'archive writes lifecycle metadata'
);

SELECT is(
  (
    SELECT managed_metadata->>'archive_reason'
      FROM public.webhook_sources
     WHERE id = current_setting('test.b6_ws_archive_source')::uuid
  ),
  'Legacy integration retired',
  'archive writes operator reason metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE decision_category = 'webhook_processing'
       AND resource_id = current_setting('test.b6_ws_archive_source')::uuid
  ),
  'archive writes decision_log row'
);

SELECT is(
  (
    SELECT lifecycle_state
      FROM public.v_webhook_source_directory
     WHERE id = current_setting('test.b6_ws_archive_source')::uuid
  ),
  'archived',
  'archive is visible through webhook source directory lifecycle projection'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE event_type = 'webhook_source.archived'
       AND resource_id = current_setting('test.b6_ws_archive_source')::uuid
  ),
  'archive emits domain event'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_archive_ops_a'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_archive_webhook_source_v1(jsonb_build_object(
      'source_id', current_setting('test.b6_ws_archive_source'),
      'reason', 'Second archive attempt'
    ))->>'already_processed')::bool
  ),
  'archive is idempotent when source is already archived'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_archive_ops_a'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_archive_webhook_source_v1(jsonb_build_object(
      'source_id', current_setting('test.b6_ws_archive_drift_source'),
      'reason', 'Repair drifted archived source'
    ))->>'ok')::bool
  ),
  'archive retry repairs drifted archived metadata rows'
);
RESET ROLE;

SELECT is(
  (
    SELECT enabled::text
      FROM public.webhook_sources
     WHERE id = current_setting('test.b6_ws_archive_drift_source')::uuid
  ),
  'false',
  'archive retry forces drifted archived source disabled'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_archive_ops_a'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_upsert_webhook_source_v1(jsonb_build_object(
       'source_id', current_setting('test.b6_ws_archive_source'),
       'name', 'Should not edit archived source'
     )) $$,
  '23514',
  NULL,
  'archived webhook source cannot be edited or re-enabled'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_archive_ops_a'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_rotate_webhook_source_token_v1(jsonb_build_object(
       'source_id', current_setting('test.b6_ws_archive_source')
     )) $$,
  '23514',
  NULL,
  'archived webhook source cannot rotate tokens'
);
RESET ROLE;

SELECT is(
  (
    SELECT command.value->'route_targets'->'console'->>'path'
      FROM jsonb_array_elements(public.ui_command_registry_v1()->'commands') AS command(value)
     WHERE command.value->>'key' = 'webhooks.archive_source'
     LIMIT 1
  ),
  '/integrations/sources',
  'archive command registry routes to Integrations Sources'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_archive_ops_a'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_archive_webhook_source_v1(jsonb_build_object(
       'source_id', current_setting('test.b6_ws_archive_source')
     )) $$,
  '23502',
  NULL,
  'archive requires operator reason'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_archive_driver_a'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_archive_webhook_source_v1(jsonb_build_object(
       'source_id', current_setting('test.b6_ws_archive_source'),
       'reason', 'driver denied'
     )) $$,
  '42501',
  NULL,
  'non-writer user denied archive'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_archive_ops_b'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_archive_webhook_source_v1(jsonb_build_object(
       'source_id', current_setting('test.b6_ws_archive_source'),
       'reason', 'cross tenant denied'
     )) $$,
  '42501',
  NULL,
  'tenant operator cannot archive source outside tenant scope'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
