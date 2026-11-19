-- pgTAP: Console V2 API gateway time-window controls are backed by the
-- canonical API-visible lookup catalog.

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
  '814f2b9a-a461-44b2-a164-762f7be4e881'::uuid,
  'Console V2 API Gateway Range Lookup Org',
  'console-v2-api-gateway-range-lookup-org'
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
  'cae026a5-c9a6-4695-892a-571f1cc39c88'::uuid,
  '814f2b9a-a461-44b2-a164-762f7be4e881'::uuid,
  'console-v2-api-gateway-range-lookups@example.test',
  'Console V2 API Gateway Range Lookup Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', 'cae026a5-c9a6-4695-892a-571f1cc39c88', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'cae026a5-c9a6-4695-892a-571f1cc39c88',
    'role', 'authenticated',
    'email', 'console-v2-api-gateway-range-lookups@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT count(*)::int
      FROM api.list_lookup_values_v1('time_range_options') AS row
     WHERE row.value IN ('5m', '1h', '24h', '7d', 'all')
  ),
  5,
  'all API gateway time-window lookup rows are API-visible'
);

SELECT is(
  (SELECT row.label FROM api.list_lookup_values_v1('time_range_options') AS row WHERE row.value = '1h'),
  '1h',
  'time_range_options.1h resolves to operator label'
);

SELECT is(
  (SELECT (row.metadata->>'window_ms')::int FROM api.list_lookup_values_v1('time_range_options') AS row WHERE row.value = '1h'),
  3600000,
  'time_range_options.1h carries canonical window_ms'
);

SELECT is(
  (SELECT (row.metadata->>'window_ms')::int FROM api.list_lookup_values_v1('time_range_options') AS row WHERE row.value = '24h'),
  86400000,
  'time_range_options.24h carries canonical window_ms'
);

SELECT is(
  (SELECT (row.metadata->>'window_ms')::int FROM api.list_lookup_values_v1('time_range_options') AS row WHERE row.value = '7d'),
  604800000,
  'time_range_options.7d carries canonical window_ms'
);

SELECT is(
  (SELECT row.metadata->>'window_ms' FROM api.list_lookup_values_v1('time_range_options') AS row WHERE row.value = 'all'),
  NULL,
  'time_range_options.all carries null window_ms sentinel'
);

SELECT is(
  (SELECT row.is_default FROM api.list_lookup_values_v1('time_range_options') AS row WHERE row.value = '1h'),
  true,
  'time_range_options.1h remains the default operator window'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
