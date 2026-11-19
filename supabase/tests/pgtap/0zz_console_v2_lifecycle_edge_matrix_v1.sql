-- pgTAP: Console V2 lifecycle edge matrix.
-- Mirrors the Browser lifecycle edge suite so critical operator-edge paths
-- are backed by database contract proof, not only frontend smoke coverage.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

DO $setup$
DECLARE
  v_org UUID := '0f850000-0000-4000-8000-000000000001'::uuid;
  v_user UUID := '0f850000-0000-4000-8000-000000000101'::uuid;
  v_provider UUID := '0f850000-0000-4000-8000-000000000201'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES (v_org, 'Console V2 Lifecycle Edge Org', 'console-v2-lifecycle-edge', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user,
    v_org,
    'console-v2-lifecycle-edge@example.test',
    'Console V2 Lifecycle Edge User',
    'super_admin',
    'active',
    'platform',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status, metadata)
  VALUES (v_provider, v_org, 'Lifecycle Edge Provider', 'http', TRUE, 10, 'healthy', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.console_lifecycle_edge_org', v_org::text, true);
  PERFORM set_config('test.console_lifecycle_edge_user', v_user::text, true);
  PERFORM set_config('test.console_lifecycle_edge_provider', v_provider::text, true);
END
$setup$;

SET LOCAL ROLE service_role;

SELECT set_config('request.jwt.claim.sub', current_setting('test.console_lifecycle_edge_user'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', current_setting('test.console_lifecycle_edge_user'),
    'role', 'service_role',
    'email', 'console-v2-lifecycle-edge@example.test'
  )::text,
  true
);

SELECT is(
  public.tenant_signup_request_create_v1(
    'edge-turnstile@example.com',
    'Edge Turnstile',
    'Edge Turnstile Org',
    NULL,
    NULL,
    NULL,
    'edge matrix',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    'edge-turnstile-ip',
    FALSE
  ) #>> '{error,code}',
  'turnstile_required',
  'public tenant intake fails closed when Turnstile proof is missing'
);

SELECT is(
  public.tenant_signup_request_create_v1(
    'not-an-email',
    'Edge Invalid Email',
    'Edge Invalid Email Org',
    NULL,
    NULL,
    NULL,
    'edge matrix',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    'edge-invalid-email-ip',
    TRUE
  ) #>> '{error,code}',
  'invalid_email',
  'public tenant intake rejects invalid email before queueing access'
);

WITH first_request AS (
  SELECT public.tenant_signup_request_create_v1(
    'edge-dedupe@example.com',
    'Edge Dedupe',
    'Edge Dedupe Org',
    NULL,
    NULL,
    NULL,
    'edge matrix',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    'edge-dedupe-ip',
    TRUE
  ) AS payload
), second_request AS (
  SELECT public.tenant_signup_request_create_v1(
    'edge-dedupe@example.com',
    'Edge Dedupe Again',
    'Edge Dedupe Org Again',
    NULL,
    NULL,
    NULL,
    'edge matrix duplicate',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    'edge-dedupe-ip-2',
    TRUE
  ) AS payload
)
SELECT ok(
  COALESCE((second_request.payload->>'deduped')::boolean, FALSE)
  AND second_request.payload->>'id' = first_request.payload->>'id',
  'tenant intake dedupes repeated requester email into the same review queue item'
)
FROM first_request, second_request;

SELECT throws_ok(
  $$ SELECT public.create_vehicle_v1(jsonb_build_object(
       'organization_id', current_setting('test.console_lifecycle_edge_org')
     )) $$,
  '22023',
  'create_vehicle_v1: plate_number is required',
  'vehicle creation rejects missing plate number before writing fleet state'
);

SELECT throws_ok(
  $$ SELECT public.ui_upsert_provider_auth_config_v1(jsonb_build_object(
       'provider_id', current_setting('test.console_lifecycle_edge_provider'),
       'auth_type', 'api_key'
     )) $$,
  '23502',
  'ui_upsert_provider_auth_config_v1 requires credentials or credentials_vault_id for create',
  'provider credential create rejects missing secret material'
);

SELECT throws_ok(
  $$ SELECT public.basket_create_v1(jsonb_build_object(
       'organization_id', current_setting('test.console_lifecycle_edge_org'),
       'capacity_count', 0
     )) $$,
  '23514',
  'basket_create_v1 capacity_count must be positive',
  'basket creation rejects non-positive capacity'
);

SELECT throws_ok(
  $$ SELECT public.zone_update_v1(jsonb_build_object(
       'zone_id', gen_random_uuid(),
       'patch', jsonb_build_object('metadata', jsonb_build_object('lifecycle', 'retired'))
     )) $$,
  '22023',
  'zone_update_v1 only patches profile fields; use suspend/restore/zone_delete_v1 for lifecycle',
  'zone profile update rejects lifecycle mutation fields'
);

SELECT ok(
  to_regprocedure('api.basket_item_add_v1(jsonb)') IS NULL
  AND to_regprocedure('api.basket_item_remove_v1(jsonb)') IS NULL,
  'Console V2 has no direct basket item mutation shortcut'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') item(value)
    WHERE item.value->>'key' = 'baskets'
  ),
  'ui_read_registry exposes baskets for Console V2 live reads'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') item(value)
    WHERE item.value->>'key' = 'integration_credential_directory'
  ),
  'ui_read_registry exposes integration credential directory for provider credential supervision'
);

SELECT has_function(
  'api',
  'ui_upsert_provider_auth_config_v1',
  ARRAY['jsonb'],
  'api.ui_upsert_provider_auth_config_v1 wrapper exists for browser-safe provider credential writes'
);

SELECT has_function(
  'api',
  'create_vehicle_v1',
  ARRAY['jsonb'],
  'api.create_vehicle_v1 wrapper exists for browser-safe vehicle creation'
);

SELECT has_function(
  'api',
  'basket_create_v1',
  ARRAY['jsonb'],
  'api.basket_create_v1 wrapper exists for browser-safe basket creation'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.release_deploy_proof_governance_v1
    WHERE id = 'console-stg'
      AND surface_id = 'console'
      AND evidence_required
  ),
  'release proof governance includes Console V2 same-SHA evidence surface'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
