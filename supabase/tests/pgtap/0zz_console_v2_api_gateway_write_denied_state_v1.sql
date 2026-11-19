-- pgTAP: Console V2 API Gateway write actions deny lower-permission users
-- before mutating source state or writing lifecycle/audit side effects.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000a651';
  v_ops UUID := '00000000-0000-0000-0000-00000000a652';
  v_limited UUID := '00000000-0000-0000-0000-00000000a653';
  v_mapping UUID := '00000000-0000-0000-0000-00000000a654';
  v_source UUID := '00000000-0000-0000-0000-00000000a655';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 API Gateway Denied Org', 'console-v2-api-gateway-denied')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'api-gateway-denied-ops@example.com', 'API Gateway Denied Ops', 'ops_admin', 'tenant', NULL),
    (v_limited, v_org, 'api-gateway-denied-limited@example.com', 'API Gateway Denied Limited', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    v_org,
    'webhook_inbound',
    'console-v2-api-gateway-denied',
    jsonb_build_object('target', 'shipments.create'),
    1,
    'Console V2 API Gateway denied-state pgTAP mapping'
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
    rate_limit_per_hour
  )
  VALUES (
    v_source,
    v_org,
    'console-v2-api-gateway-denied-source',
    'Console V2 API Gateway Denied Source',
    'api_gateway',
    'console-v2-api-gateway-denied-token',
    v_mapping,
    TRUE,
    240
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_config_id = EXCLUDED.mapping_config_id,
         enabled = TRUE,
         rate_limit_per_hour = 240;

  PERFORM set_config('test.api_gateway_denied_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.api_gateway_denied_ops', v_ops::TEXT, TRUE);
  PERFORM set_config('test.api_gateway_denied_limited', v_limited::TEXT, TRUE);
  PERFORM set_config('test.api_gateway_denied_source', v_source::TEXT, TRUE);

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  to_regprocedure('api.block_api_gateway_source_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.block_api_gateway_source_v1(jsonb)', 'EXECUTE'),
  'api.block_api_gateway_source_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.adjust_api_gateway_rate_limit_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.adjust_api_gateway_rate_limit_v1(jsonb)', 'EXECUTE'),
  'api.adjust_api_gateway_rate_limit_v1 wrapper is available to authenticated users'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.api_gateway_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.block_api_gateway_source_v1(jsonb_build_object(
       'source_id', current_setting('test.api_gateway_denied_source'),
       'reason', 'pgtap-denied-block-public'
     )) $$,
  '42501',
  NULL,
  'limited user denied public block_api_gateway_source_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.api_gateway_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.block_api_gateway_source_v1(jsonb_build_object(
       'source_id', current_setting('test.api_gateway_denied_source'),
       'reason', 'pgtap-denied-block-api'
     )) $$,
  '42501',
  NULL,
  'limited user denied api block_api_gateway_source_v1'
);
RESET ROLE;

SELECT is(
  (
    SELECT enabled
      FROM public.webhook_sources
     WHERE id = current_setting('test.api_gateway_denied_source')::UUID
  ),
  TRUE,
  'denied block attempts leave API source enabled'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE resource_id = current_setting('test.api_gateway_denied_source')::UUID
       AND event_type = 'api_gateway.source.blocked'
       AND payload->>'reason' IN ('pgtap-denied-block-public', 'pgtap-denied-block-api')
  ),
  'denied block attempts write no source-blocked domain event'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.api_gateway_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.adjust_api_gateway_rate_limit_v1(jsonb_build_object(
       'source_id', current_setting('test.api_gateway_denied_source'),
       'limit_per_hour', 60,
       'reason', 'pgtap-denied-rate-public'
     )) $$,
  '42501',
  NULL,
  'limited user denied public adjust_api_gateway_rate_limit_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.api_gateway_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.adjust_api_gateway_rate_limit_v1(jsonb_build_object(
       'source_id', current_setting('test.api_gateway_denied_source'),
       'limit_per_hour', 30,
       'reason', 'pgtap-denied-rate-api'
     )) $$,
  '42501',
  NULL,
  'limited user denied api adjust_api_gateway_rate_limit_v1'
);
RESET ROLE;

SELECT is(
  (
    SELECT rate_limit_per_hour
      FROM public.webhook_sources
     WHERE id = current_setting('test.api_gateway_denied_source')::UUID
  ),
  240,
  'denied rate-limit attempts leave API source rate limit unchanged'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE resource_id = current_setting('test.api_gateway_denied_source')::UUID
       AND event_type = 'api_gateway.rate_limit.adjusted'
       AND payload->>'reason' IN ('pgtap-denied-rate-public', 'pgtap-denied-rate-api')
  ),
  'denied rate-limit attempts write no rate-limit domain event'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE resource_id = current_setting('test.api_gateway_denied_source')::UUID
       AND decision_category = 'api_gateway_source_lifecycle'
       AND decision_reason IN (
         'pgtap-denied-block-public',
         'pgtap-denied-block-api',
         'pgtap-denied-rate-public',
         'pgtap-denied-rate-api'
       )
  ),
  'denied API Gateway write attempts write no lifecycle decision rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.api_gateway_denied_ops'), TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.adjust_api_gateway_rate_limit_v1(jsonb_build_object(
      'source_id', current_setting('test.api_gateway_denied_source'),
      'limit_per_hour', 240,
      'reason', 'pgtap-idempotent-ops-readback'
    ))->>'already_processed')::BOOLEAN
  ),
  'ops user can still reach idempotent rate-limit write path'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
