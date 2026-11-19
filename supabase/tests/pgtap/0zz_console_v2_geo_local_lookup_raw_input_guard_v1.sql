-- pgTAP: Console V2 geocode local lookup raw-input guard

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

INSERT INTO public.organizations (id, name, slug)
VALUES ('0cc20000-0000-0000-0000-000000000001', 'Console V2 Geo Raw Guard Org', 'console-v2-geo-raw-guard-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '0cc20000-0000-0000-0000-000000000002',
  '0cc20000-0000-0000-0000-000000000001',
  'Console V2 Geo Raw Guard Client',
  'console-v2-geo-raw-guard-client'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name)
VALUES (
  '0cc20000-0000-0000-0000-000000000003',
  '0cc20000-0000-0000-0000-000000000002',
  'Console V2 Geo Raw Guard Sender',
  'Console V2 Geo Raw Guard Sender'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  line1,
  normalized_line1,
  city,
  province,
  country,
  validation_status,
  created_at,
  updated_at
) VALUES (
  '0cc20000-0000-0000-0000-000000000004',
  '0cc20000-0000-0000-0000-000000000001',
  '0cc20000-0000-0000-0000-000000000002',
  'External Signed Destination Line',
  'External Signed Destination Line',
  'External Signed Destination Line',
  'Riyadh',
  'Riyadh',
  'SA',
  'pending',
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

INSERT INTO public.canonical_cities (
  id,
  organization_id,
  name_canonical,
  name_arabic,
  alternate_names,
  province,
  country_code,
  source,
  centroid,
  source_city_id,
  region_code
) VALUES (
  '0cc20000-0000-0000-0000-000000000009',
  '0cc20000-0000-0000-0000-000000000001',
  'Riyadh',
  'الرياض',
  ARRAY['Riyadh City'],
  'Riyadh',
  'SA',
  'ops_verified',
  ST_SetSRID(ST_MakePoint(46.6753, 24.7136), 4326)::geography,
  99002001,
  'RD'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.canonical_districts (
  id,
  organization_id,
  city_id,
  name_canonical,
  name_arabic,
  alternate_names,
  source,
  centroid,
  source_district_id
) VALUES (
  '0cc20000-0000-0000-0000-000000000010',
  '0cc20000-0000-0000-0000-000000000001',
  '0cc20000-0000-0000-0000-000000000009',
  'Al Olaya',
  'العليا',
  ARRAY['Olaya'],
  'ops_verified',
  ST_SetSRID(ST_MakePoint(46.6753, 24.7136), 4326)::geography,
  99002002
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
) VALUES (
  '0cc20000-0000-0000-0000-000000000005',
  'console_v2_geo_raw_guard',
  'Console V2 geocode raw-input guard',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  enabled
) VALUES (
  '0cc20000-0000-0000-0000-000000000006',
  '0cc20000-0000-0000-0000-000000000005',
  1,
  'local_lookup',
  'always',
  'geo_local_lookup',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', '0cc20000-0000-0000-0000-000000000007', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '0cc20000-0000-0000-0000-000000000007',
  '0cc20000-0000-0000-0000-000000000005',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '0cc20000-0000-0000-0000-000000000001',
    'client_id', '0cc20000-0000-0000-0000-000000000002',
    'sender_id', '0cc20000-0000-0000-0000-000000000003',
    'address_id', '0cc20000-0000-0000-0000-000000000004'
  )
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_run_steps (
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
) VALUES (
  '0cc20000-0000-0000-0000-000000000008',
  '0cc20000-0000-0000-0000-000000000007',
  '0cc20000-0000-0000-0000-000000000006',
  1,
  'pending',
  'local_lookup',
  'geo_local_lookup',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

WITH policy AS (
  SELECT jsonb_build_object(
    'provider_priority', '[]'::jsonb,
    'local_lookup', jsonb_build_object('enabled', TRUE),
    'matching_plugins', jsonb_build_array(
      jsonb_build_object('name', 'perfect', 'enabled', TRUE),
      jsonb_build_object('name', 'fuzzy', 'enabled', TRUE)
    )
  ) AS value
),
settings_version AS (
  SELECT *
  FROM public.upsert_settings_value_v1(
    'geocoding_policy',
    'sender',
    '0cc20000-0000-0000-0000-000000000003'::uuid,
    (SELECT value FROM policy),
    1,
    'pgtap: Console V2 geocode raw-input guard policy seed'
  )
)
SELECT 1 FROM settings_version;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'geocoding_policy:%';

CREATE TEMP TABLE tmp_console_v2_geo_raw_guard AS
SELECT workflow_handlers.execute_geo_local_lookup_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '0cc20000-0000-0000-0000-000000000008'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '0cc20000-0000-0000-0000-000000000007'),
  '{}'::jsonb
) AS resp;

SELECT is(
  (SELECT to_jsonb(resp)->>'status' FROM tmp_console_v2_geo_raw_guard),
  'completed',
  'plain-text raw_input does not fail local lookup'
);

SELECT ok(
  COALESCE((SELECT (to_jsonb(resp)->'operation_result'->>'matched')::boolean FROM tmp_console_v2_geo_raw_guard), FALSE),
  'plain-text raw_input resolves from normalized address columns'
);

SELECT is(
  (SELECT to_jsonb(resp)->'context_patch'->'geocoding'->>'match_plugin' FROM tmp_console_v2_geo_raw_guard),
  'plain_raw_input_guard',
  'plain-text raw_input marks the normalized-column guard path'
);

SELECT * FROM finish();
ROLLBACK;
