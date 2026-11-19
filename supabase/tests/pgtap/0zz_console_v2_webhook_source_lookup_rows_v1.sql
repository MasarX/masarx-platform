-- pgTAP: Console V2 webhook-source lookup rows are available through the API
-- schema path used by browser/live Console V2 metadata hydration.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_function(
  'api',
  'list_lookup_values_v1',
  ARRAY['text'],
  'api.list_lookup_values_v1(text) exists for browser lookup hydration'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'e8dfc2e6-d9b7-43c7-9ed9-c411c08f6353'::uuid,
  'Console V2 Webhook Lookup Org',
  'console-v2-webhook-lookup-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  '32bd8c1d-324d-4d64-a1cf-277500a81d13'::uuid,
  'e8dfc2e6-d9b7-43c7-9ed9-c411c08f6353'::uuid,
  'console-v2-webhook-lookups@example.test',
  'Console V2 Webhook Lookup Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', '32bd8c1d-324d-4d64-a1cf-277500a81d13', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '32bd8c1d-324d-4d64-a1cf-277500a81d13',
    'role', 'authenticated',
    'email', 'console-v2-webhook-lookups@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT row.label
    FROM api.list_lookup_values_v1('webhook_provider_type') AS row
    WHERE row.value = 'generic'
  ),
  'Generic JSON',
  'webhook_provider_type.generic resolves to the operator-facing label'
);

SELECT is(
  (
    SELECT row.metadata->>'tone'
    FROM api.list_lookup_values_v1('webhook_provider_type') AS row
    WHERE row.value = 'delivery_provider'
  ),
  'warn',
  'webhook_provider_type.delivery_provider carries tone metadata'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM api.list_lookup_values_v1('webhook_provider_type') AS row
    WHERE row.value IN ('shopify', 'woocommerce', 'generic', 'custom_erp', 'delivery_provider')
  ),
  5,
  'all Console V2 webhook provider types are API-visible'
);

SELECT is(
  (
    SELECT row.label
    FROM api.list_lookup_values_v1('enabled_state') AS row
    WHERE row.value = 'enabled'
  ),
  'Enabled',
  'enabled_state.enabled resolves for Console V2 toggles'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM api.list_lookup_values_v1('enabled_state') AS row
    WHERE row.value IN ('enabled', 'disabled')
  ),
  2,
  'both enabled_state lookup values are API-visible'
);

SELECT is(
  (
    SELECT row.label
    FROM api.list_lookup_values_v1('webhook_source_health') AS row
    WHERE row.value = 'idle'
  ),
  'Idle',
  'webhook_source_health.idle resolves for source directory projections'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM api.list_lookup_values_v1('webhook_source_health') AS row
    WHERE row.value IN ('healthy', 'degraded', 'idle')
  ),
  3,
  'all webhook_source_health lookup values are API-visible'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
