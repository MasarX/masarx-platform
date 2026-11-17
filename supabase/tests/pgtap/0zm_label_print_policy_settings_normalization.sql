BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

CREATE TEMP TABLE _label_print_policy_schema AS
SELECT version
FROM public.schema_registry
WHERE category = 'label_print_policy'
  AND is_active = TRUE
ORDER BY version DESC
LIMIT 1;

SELECT is(
  (SELECT COUNT(*) FROM _label_print_policy_schema),
  1::bigint,
  'active label_print_policy schema exists'
);

CREATE TEMP TABLE _label_print_policy_base AS
SELECT s.cached_value AS value
FROM public.settings s
WHERE s.category = 'label_print_policy'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY s.last_updated DESC
LIMIT 1;

SELECT is(
  (SELECT COUNT(*) FROM _label_print_policy_base),
  1::bigint,
  'active global label_print_policy row exists for normalization tests'
);

CREATE TEMP TABLE _label_print_policy_floor_upsert AS
SELECT *
FROM public.upsert_settings_value_v1(
  'label_print_policy',
  'global',
  NULL,
  jsonb_set(
    (SELECT value FROM _label_print_policy_base),
    '{poll_interval_seconds}',
    to_jsonb(1),
    true
  ),
  (SELECT version FROM _label_print_policy_schema),
  'pgTAP normalize label_print_policy poll interval floor'
);

CREATE TEMP TABLE _label_print_policy_floor AS
SELECT s.cached_value AS value
FROM public.settings s
WHERE s.category = 'label_print_policy'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY s.last_updated DESC
LIMIT 1;

SELECT is(
  (SELECT (value->>'poll_interval_seconds')::int FROM _label_print_policy_floor),
  5,
  'upsert_settings_value_v1 floors label_print_policy poll_interval_seconds to schema minimum'
);

CREATE TEMP TABLE _label_print_policy_string_floor_upsert AS
SELECT *
FROM public.upsert_settings_value_v1(
  'label_print_policy',
  'global',
  NULL,
  jsonb_set(
    (SELECT value FROM _label_print_policy_base),
    '{poll_interval_seconds}',
    '"1"'::jsonb,
    true
  ),
  (SELECT version FROM _label_print_policy_schema),
  'pgTAP normalize label_print_policy poll interval string floor'
);

CREATE TEMP TABLE _label_print_policy_string_floor AS
SELECT s.cached_value AS value
FROM public.settings s
WHERE s.category = 'label_print_policy'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY s.last_updated DESC
LIMIT 1;

SELECT is(
  (SELECT (value->>'poll_interval_seconds')::int FROM _label_print_policy_string_floor),
  5,
  'upsert_settings_value_v1 normalizes string poll_interval_seconds to the schema minimum'
);

SELECT * FROM finish();

ROLLBACK;
