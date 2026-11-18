-- pgTAP: Console V2 webhook source write actions deny lower-permission users
-- before mutating source state or writing lifecycle/audit side effects.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b751';
  v_ops UUID := '00000000-0000-0000-0000-00000000b752';
  v_limited UUID := '00000000-0000-0000-0000-00000000b753';
  v_mapping UUID := '00000000-0000-0000-0000-00000000b754';
  v_source UUID := '00000000-0000-0000-0000-00000000b755';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Webhook Source Denied Org', 'console-v2-webhook-source-denied')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'webhook-source-denied-ops@example.com', 'Webhook Source Denied Ops', 'ops_admin', 'tenant', NULL),
    (v_limited, v_org, 'webhook-source-denied-limited@example.com', 'Webhook Source Denied Limited', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    v_org,
    'webhook_inbound',
    'console-v2-webhook-source-denied',
    '{}'::jsonb,
    1,
    'Console V2 webhook source denied-state pgTAP mapping'
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_config = EXCLUDED.mapping_config;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    enabled,
    rate_limit_per_hour,
    managed_metadata
  )
  VALUES (
    v_source,
    v_org,
    'console-v2-webhook-source-denied-source',
    'Console V2 Webhook Source Denied Source',
    'generic',
    'console-v2-webhook-source-denied-token',
    v_mapping,
    TRUE,
    240,
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_config_id = EXCLUDED.mapping_config_id,
         enabled = TRUE,
         rate_limit_per_hour = 240,
         managed_metadata = '{}'::jsonb;

  PERFORM set_config('test.webhook_source_denied_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.webhook_source_denied_ops', v_ops::TEXT, TRUE);
  PERFORM set_config('test.webhook_source_denied_limited', v_limited::TEXT, TRUE);
  PERFORM set_config('test.webhook_source_denied_mapping', v_mapping::TEXT, TRUE);
  PERFORM set_config('test.webhook_source_denied_source', v_source::TEXT, TRUE);
  PERFORM set_config(
    'test.webhook_source_denied_initial_token',
    (SELECT COALESCE(auth_token, '__NULL__') FROM public.webhook_sources WHERE id = v_source),
    TRUE
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  to_regprocedure('api.ui_upsert_webhook_source_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_upsert_webhook_source_v1(jsonb)', 'EXECUTE'),
  'api.ui_upsert_webhook_source_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.ui_rotate_webhook_source_token_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_rotate_webhook_source_token_v1(jsonb)', 'EXECUTE'),
  'api.ui_rotate_webhook_source_token_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.ui_archive_webhook_source_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_archive_webhook_source_v1(jsonb)', 'EXECUTE'),
  'api.ui_archive_webhook_source_v1 wrapper is available to authenticated users'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_source_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_upsert_webhook_source_v1(jsonb_build_object(
       'source_identifier', 'console-v2-webhook-source-denied-public-create',
       'name', 'Denied public create',
       'provider_type', 'generic',
       'mapping_config_id', current_setting('test.webhook_source_denied_mapping')
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_upsert_webhook_source_v1 create'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_source_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_upsert_webhook_source_v1(jsonb_build_object(
       'source_identifier', 'console-v2-webhook-source-denied-api-create',
       'name', 'Denied api create',
       'provider_type', 'generic',
       'mapping_config_id', current_setting('test.webhook_source_denied_mapping')
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_upsert_webhook_source_v1 create'
);
RESET ROLE;

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.webhook_sources
     WHERE source_identifier IN (
       'console-v2-webhook-source-denied-public-create',
       'console-v2-webhook-source-denied-api-create'
     )
  ),
  'denied source create attempts write no webhook_sources rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_source_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_rotate_webhook_source_token_v1(jsonb_build_object(
       'source_id', current_setting('test.webhook_source_denied_source')
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_rotate_webhook_source_token_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_source_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_rotate_webhook_source_token_v1(jsonb_build_object(
       'source_id', current_setting('test.webhook_source_denied_source')
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_rotate_webhook_source_token_v1'
);
RESET ROLE;

SELECT is(
  (
    SELECT COALESCE(auth_token, '__NULL__')
      FROM public.webhook_sources
     WHERE id = current_setting('test.webhook_source_denied_source')::UUID
  ),
  current_setting('test.webhook_source_denied_initial_token'),
  'denied rotate attempts leave stored token unchanged'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE resource_id = current_setting('test.webhook_source_denied_source')::UUID
       AND event_type = 'webhook_source.token_rotated'
  ),
  'denied rotate attempts write no token-rotated domain event'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_source_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_archive_webhook_source_v1(jsonb_build_object(
       'source_id', current_setting('test.webhook_source_denied_source'),
       'reason', 'pgtap-denied-archive-public'
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_archive_webhook_source_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_source_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_archive_webhook_source_v1(jsonb_build_object(
       'source_id', current_setting('test.webhook_source_denied_source'),
       'reason', 'pgtap-denied-archive-api'
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_archive_webhook_source_v1'
);
RESET ROLE;

SELECT is(
  (
    SELECT enabled
      FROM public.webhook_sources
     WHERE id = current_setting('test.webhook_source_denied_source')::UUID
  ),
  TRUE,
  'denied archive attempts leave webhook source enabled'
);

SELECT is(
  (
    SELECT COALESCE(managed_metadata->>'lifecycle', 'active')
      FROM public.webhook_sources
     WHERE id = current_setting('test.webhook_source_denied_source')::UUID
  ),
  'active',
  'denied archive attempts do not mark lifecycle archived'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE resource_id = current_setting('test.webhook_source_denied_source')::UUID
       AND event_type = 'webhook_source.archived'
  ),
  'denied archive attempts write no archived domain event'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE (
       resource_id = current_setting('test.webhook_source_denied_source')::UUID
       OR decision_inputs->>'source_identifier' IN (
         'console-v2-webhook-source-denied-public-create',
         'console-v2-webhook-source-denied-api-create'
       )
     )
       AND decision_category IN (
         'webhooks.upsert_source',
         'webhooks.rotate_source_token',
         'webhook_processing'
       )
       AND performed_by_system IN (
         'ui_upsert_webhook_source_v1',
         'ui_rotate_webhook_source_token_v1',
         'ui_archive_webhook_source_v1'
       )
  ),
  'denied webhook source write attempts write no lifecycle decision rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_source_denied_ops'), TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_rotate_webhook_source_token_v1(jsonb_build_object(
      'source_id', current_setting('test.webhook_source_denied_source')
    ))->>'ok')::BOOLEAN
  ),
  'ops user can still reach webhook source token rotate path'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
