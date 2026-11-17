-- Test Suite: Short-code reverse geocode hydrates normalized_line2
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);
SET search_path TO public, pgtap, extensions;

-- Fixture: org/client/sender
INSERT INTO public.organizations (id, name, slug)
VALUES ('08100000-0000-0000-0000-000000000001', 'PGTAP Geo Org 081', 'pgtap-geo-081')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  '08100000-0000-0000-0000-000000000002',
  '08100000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 081',
  'pgtap-geo-client-081'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name)
VALUES (
  '08100000-0000-0000-0000-000000000003',
  '08100000-0000-0000-0000-000000000002',
  'PGTAP Geo Sender 081',
  'PGTAP Geo Sender 081'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  line1,
  normalized_line1,
  normalized_line2,
  district,
  city,
  province,
  postal_code,
  country,
  validation_status,
  sa_short_code,
  created_at,
  updated_at
) VALUES (
  '08100000-0000-0000-0000-000000000004',
  '08100000-0000-0000-0000-000000000001',
  '08100000-0000-0000-0000-000000000002',
  'TEST0000',
  'TEST0000',
  NULL,
  NULL,
  NULL,
  'Example City',
  'Example City',
  NULL,
  'SA',
  'pending',
  'TEST0000',
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

-- Mapping config + provider + template
INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes,
  created_at,
  updated_at
) VALUES (
  '08100000-0000-0000-0000-000000000010',
  'provider_response',
  'pgtap::geocoding_reverse_v1',
  jsonb_build_object(
    'field_mappings',
    jsonb_build_object(
      'latitude', '$.lat',
      'longitude', '$.lng',
      'district', '$.district',
      'city', '$.city',
      'province', '$.province',
      'postal_code', '$.postal',
      'country_code', '$.country',
      'house_number', '$.house',
      'street', '$.street',
      'confidence_score', '$.confidence',
      'formatted_address', '$.formatted'
    )
  ),
  1,
  'PGTAP reverse mapping',
  now(),
  now()
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    updated_at = now();

INSERT INTO public.providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status, created_at, updated_at)
VALUES (
  '08100000-0000-0000-0000-000000000011',
  '08100000-0000-0000-0000-000000000001',
  'pgtap_geocode_provider_081',
  'geocoding',
  TRUE,
  100,
  'healthy',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.operation_templates (
  id,
  provider_id,
  operation_name,
  method,
  url_template,
  headers_template,
  body_template,
  request_mappings,
  mapping_config_id,
  handler_key,
  handler_version,
  metadata,
  created_at,
  updated_at
) VALUES (
  '08100000-0000-0000-0000-000000000012',
  '08100000-0000-0000-0000-000000000011',
  'geocoding_pgtap_reverse_v1',
  'GET',
  'https://example.com/reverse',
  '{}'::jsonb,
  NULL,
  NULL,
  '08100000-0000-0000-0000-000000000010',
  'outbound_http',
  'v1',
  jsonb_build_object('operation_role', 'geocoding_reverse'),
  now(),
  now()
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
  '08100000-0000-0000-0000-000000000020',
  'pgtap_geo_reverse_081',
  'PGTAP geo reverse handler test',
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
  '08100000-0000-0000-0000-000000000021',
  '08100000-0000-0000-0000-000000000020',
  1,
  'dispatch_provider',
  'always',
  'provider_dispatch',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Workflow guardrails require app.workflow_run_id context for inserts.
SELECT set_config('app.workflow_run_id', '08100000-0000-0000-0000-000000000030', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '08100000-0000-0000-0000-000000000030',
  '08100000-0000-0000-0000-000000000020',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '08100000-0000-0000-0000-000000000001',
    'client_id', '08100000-0000-0000-0000-000000000002',
    'sender_id', '08100000-0000-0000-0000-000000000003',
    'address_id', '08100000-0000-0000-0000-000000000004',
    'geocoding', jsonb_build_object('short_code', 'TEST0000')
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
  '08100000-0000-0000-0000-000000000031',
  '08100000-0000-0000-0000-000000000030',
  '08100000-0000-0000-0000-000000000021',
  1,
  'pending',
  'dispatch_provider',
  'provider_dispatch',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', '08100000-0000-0000-0000-000000000031', true);

INSERT INTO public.outbound_calls (
  id,
  call_type,
  target_type,
  target_id,
  method,
  url,
  status,
  response_status_code,
  latency_ms,
  workflow_run_step_id,
  context,
  created_at
) VALUES (
  '08100000-0000-0000-0000-000000000040',
  'provider_api',
  'provider',
  '08100000-0000-0000-0000-000000000011',
  'GET',
  'https://example.com/reverse',
  'completed',
  200,
  120,
  '08100000-0000-0000-0000-000000000031',
  jsonb_build_object('operation_template_id', '08100000-0000-0000-0000-000000000012'),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT workflow_handlers.process_geocoding_outbound_response_v1(
  oc,
  jsonb_build_object(
    'lat', 24.772,
    'lng', 46.738,
    'district', 'Example District',
    'city', 'Example City',
    'province', 'Example City',
    'postal', '00000',
    'country', 'SA',
    'house', '1',
    'street', 'Example Street',
    'confidence', 0.95,
    'formatted', '1 Example Street, Example District, Example City 00000, SA'
  )
)
FROM public.outbound_calls oc
WHERE oc.id = '08100000-0000-0000-0000-000000000040';

SELECT is(
  (SELECT normalized_line2 FROM public.addresses WHERE id = '08100000-0000-0000-0000-000000000004'),
  'Example District',
  'short-code reverse hydrates normalized_line2'
);

SELECT is(
  (SELECT normalized_line1 FROM public.addresses WHERE id = '08100000-0000-0000-0000-000000000004'),
  '1 Example Street',
  'short-code reverse hydrates normalized_line1'
);

SELECT * FROM finish();
ROLLBACK;
