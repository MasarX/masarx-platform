BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(41);

SELECT public.create_next_partitions();

ALTER TABLE public.mapping_configs
  DROP CONSTRAINT IF EXISTS mapping_configs_type_check;

ALTER TABLE public.mapping_configs
  ADD CONSTRAINT mapping_configs_type_check
  CHECK (
    mapping_type IN (
      'provider_response',
      'webhook_inbound',
      'webhook_outbound',
      'event_extraction',
      'webhook_response',
      'tabular_import',
      'api_gateway_inbound'
    )
  );

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  organization_id,
  scope_type
)
VALUES (
  'mapping_type',
  'Mapping artifact type taxonomy (mirrors public.mapping_configs.mapping_type).',
  'engineering',
  'tier_2',
  TRUE,
  NULL,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

WITH definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'mapping_type'
  LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  definition.id,
  'api_gateway_inbound',
  'API Gateway inbound',
  'Tenant/client API Gateway request payload mapping before provider dispatch.',
  70,
  FALSE,
  'active',
  jsonb_build_object(
    'target_family', 'external_intake',
    'artifact', 'api_gateway_request_mapping'
  )
FROM definition
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    status = 'active',
    metadata = public.deep_merge_jsonb(COALESCE(public.lookup_values.metadata, '{}'::jsonb), EXCLUDED.metadata),
    updated_at = now();

INSERT INTO public.organizations (id, name, slug)
VALUES
  ('11111111-1111-4111-8111-111111111730', 'API Gateway Mapping Tenant', 'api-gateway-mapping-tenant'),
  ('11111111-1111-4111-8111-111111111731', 'API Gateway Mapping Other Tenant', 'api-gateway-mapping-other-tenant')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
VALUES
  ('77777777-7777-4777-8777-777777777730', '11111111-1111-4111-8111-111111111730', 'Mapping Client', 'mapping-client', 'standard', 'active'),
  ('77777777-7777-4777-8777-777777777731', '11111111-1111-4111-8111-111111111731', 'Mapping Other Client', 'mapping-other-client', 'standard', 'active')
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES (
  '12121212-1212-4121-8121-121212121730',
  '77777777-7777-4777-8777-777777777730',
  'API Gateway Mapping Sender',
  'API Gateway Mapping Sender',
  TRUE,
  'active'
)
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    name = EXCLUDED.name,
    brand_name = EXCLUDED.brand_name,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO public.api_route_packs (id, name, description, enabled)
VALUES ('22222222-2222-4222-8222-222222222730', 'Mapping Proof Pack', 'API Gateway request mapping proof pack', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES
(
  '33333333-3333-4333-8333-333333333730',
  '11111111-1111-4111-8111-111111111730',
  'api_gateway_inbound',
  'tenant.default.shipment.create',
  jsonb_build_object(
    'enabled', TRUE,
    'target', 'shipments.create',
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object('client_reference', 'order.id'),
      'recipient', jsonb_build_object('name', 'customer.name', 'phone', 'customer.phone')
    )
  ),
  1,
  'pgTAP tenant default API Gateway request mapping'
),
(
  '44444444-4444-4444-8444-444444444730',
  '11111111-1111-4111-8111-111111111730',
  'api_gateway_inbound',
  'client.exception.shipment.create',
  jsonb_build_object(
    'enabled', TRUE,
    'target', 'shipments.create',
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object('client_reference', 'legacy.ref'),
      'recipient', jsonb_build_object('name', 'legacy.receiverName', 'phone', 'legacy.receiverPhone')
    )
  ),
  1,
  'pgTAP client exception API Gateway request mapping'
),
(
  '44444444-4444-4444-8444-444444444731',
  '11111111-1111-4111-8111-111111111730',
  'api_gateway_inbound',
  'tenant.default.shipment.status',
  jsonb_build_object(
    'enabled', TRUE,
    'target', 'shipments.update_status',
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'tracking'),
      'status', 'state'
    )
    ),
  1,
  'pgTAP incompatible API Gateway request mapping'
),
(
  '45454545-4545-4454-8454-454545454730',
  '11111111-1111-4111-8111-111111111730',
  'api_gateway_inbound',
  'tenant.default.shipment.update_status',
  jsonb_build_object(
    'enabled', TRUE,
    'target', 'shipments.update_status',
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'tracking', 'status', 'state')
    )
  ),
  1,
  'pgTAP tenant default API Gateway status update mapping'
),
(
  '47474747-4747-4474-8474-474747474730',
  '11111111-1111-4111-8111-111111111730',
  'api_gateway_inbound',
  'tenant.default.shipment.update',
  jsonb_build_object(
    'enabled', TRUE,
    'target', 'shipments.update',
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object('external_id', 'shipmentId', 'recipient_note', 'shipment.note'),
      'recipient', jsonb_build_object('phone', 'recipient.phone')
    )
  ),
  1,
  'pgTAP tenant default API Gateway general shipment update mapping'
),
(
  '46464646-4646-4464-8464-464646464730',
  '11111111-1111-4111-8111-111111111730',
  'api_gateway_inbound',
  'tenant.default.shipment.cancel',
  jsonb_build_object(
    'enabled', TRUE,
    'target', 'shipments.cancel',
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object('external_id', 'shipmentId'),
      'cancellation', jsonb_build_object('reason', 'cancel.reason')
    )
  ),
  1,
  'pgTAP tenant default API Gateway cancel/delete mapping'
),
(
  '48484848-4848-4484-8484-484848484730',
  '11111111-1111-4111-8111-111111111730',
  'api_gateway_inbound',
  'tenant.default.shipment.delete',
  jsonb_build_object(
    'enabled', TRUE,
    'target', 'shipments.delete',
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object('external_id', 'shipmentId'),
      'deletion', jsonb_build_object('reason', 'delete.reason')
    )
  ),
  1,
  'pgTAP tenant default API Gateway shipment delete mapping'
),
(
  '35353535-3535-4353-8353-353535353730',
  '11111111-1111-4111-8111-111111111730',
  'webhook_inbound',
  'api-gateway-mapping-source::default',
  '{}'::jsonb,
  1,
  'pgTAP API Gateway request mapping source placeholder mapping'
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    mapping_config = EXCLUDED.mapping_config,
    mapping_version = EXCLUDED.mapping_version,
    notes = EXCLUDED.notes,
    updated_at = now();

INSERT INTO public.providers (id, organization_id, name, provider_type, metadata)
VALUES (
  '23232323-2323-4232-8232-232323232730',
  '11111111-1111-4111-8111-111111111730',
  'pgtap_api_gateway_request_mapping_provider',
  '3pl',
  jsonb_build_object('base_url', 'https://example.test')
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    provider_type = EXCLUDED.provider_type,
    metadata = EXCLUDED.metadata,
    updated_at = now();

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id
)
VALUES (
  '34343434-3434-4343-8343-343434343730',
  '11111111-1111-4111-8111-111111111730',
  'api-gateway-request-mapping-source',
  'API Gateway Request Mapping Source',
  'api_gateway',
  'token-api-gateway-mapping-730',
  '35353535-3535-4353-8353-353535353730',
  1000,
  TRUE,
  '12121212-1212-4121-8121-121212121730'
)
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    source_identifier = EXCLUDED.source_identifier,
    name = EXCLUDED.name,
    provider_type = EXCLUDED.provider_type,
    auth_token = EXCLUDED.auth_token,
    mapping_config_id = EXCLUDED.mapping_config_id,
    rate_limit_per_hour = EXCLUDED.rate_limit_per_hour,
    enabled = EXCLUDED.enabled,
    sender_id = EXCLUDED.sender_id,
    updated_at = now();

SELECT set_config('app.workflow_run_id', '36363636-3636-4363-8363-363636363730', true);
INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  '37373737-3737-4373-8373-373737373730',
  'pgtap_api_gateway_request_mapping',
  'Fixture workflow for API Gateway request mapping runtime tests',
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
)
VALUES (
  '38383838-3838-4383-8383-383838383730',
  '37373737-3737-4373-8373-373737373730',
  1,
  'workflow_control',
  'always',
  'workflow_control',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  '36363636-3636-4363-8363-363636363730',
  '37373737-3737-4373-8373-373737373730',
  1,
  'test',
  'pending',
  '{}'::jsonb
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
)
VALUES (
  '39393939-3939-4393-8393-393939393730',
  '36363636-3636-4363-8363-363636363730',
  '38383838-3838-4383-8383-383838383730',
  1,
  'pending',
  'workflow_control',
  'workflow_control',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', '39393939-3939-4393-8393-393939393730', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', '39393939-3939-4393-8393-393939393730', true);

INSERT INTO public.api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  policy
)
VALUES
(
  '55555555-5555-4555-8555-555555555730',
  '22222222-2222-4222-8222-222222222730',
  'Tenant default shipment create',
  TRUE,
  'POST',
  '/v1/orders',
  'tenant',
  '11111111-1111-4111-8111-111111111730',
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '33333333-3333-4333-8333-333333333730',
      'mapping_key', 'tenant.default.shipment.create',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.create'
    ),
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1')
  )
),
(
  '66666666-6666-4666-8666-666666666730',
  '22222222-2222-4222-8222-222222222730',
  'Client exception shipment create',
  TRUE,
  'POST',
  '/v1/orders',
  'client',
  '77777777-7777-4777-8777-777777777730',
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '44444444-4444-4444-8444-444444444730',
      'mapping_key', 'client.exception.shipment.create',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.create'
    ),
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1')
  )
),
(
  '99999999-9999-4999-8999-999999999730',
  '22222222-2222-4222-8222-222222222730',
  'Target mismatch shipment create',
  TRUE,
  'POST',
  '/v1/orders/mismatch',
  'tenant',
  '11111111-1111-4111-8111-111111111730',
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '44444444-4444-4444-8444-444444444731',
      'mapping_key', 'tenant.default.shipment.status',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.update_status'
    ),
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1')
  )
),
(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa730',
  '22222222-2222-4222-8222-222222222730',
  'Bindable tenant shipment create',
  TRUE,
  'POST',
  '/v1/orders/bindable',
  'tenant',
  '11111111-1111-4111-8111-111111111730',
  jsonb_build_object(
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1')
  )
),
(
  'dddddddd-dddd-4ddd-8ddd-ddddddddd730',
  '22222222-2222-4222-8222-222222222730',
  'Tenant shipment status update',
  TRUE,
  'PUT',
  '/v1/orders/{tracking}/status',
  'tenant',
  '11111111-1111-4111-8111-111111111730',
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '45454545-4545-4454-8454-454545454730',
      'mapping_key', 'tenant.default.shipment.update_status',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.update_status'
    ),
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_update_v1')
  )
),
(
  'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d730',
  '22222222-2222-4222-8222-222222222730',
  'Tenant shipment general update',
  TRUE,
  'PATCH',
  '/v1/orders/{shipmentId}',
  'tenant',
  '11111111-1111-4111-8111-111111111730',
  jsonb_build_object(
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_update_v1')
  )
),
(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeee730',
  '22222222-2222-4222-8222-222222222730',
  'Tenant shipment cancel',
  TRUE,
  'DELETE',
  '/v1/orders/{shipmentId}',
  'tenant',
  '11111111-1111-4111-8111-111111111730',
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '46464646-4646-4464-8464-464646464730',
      'mapping_key', 'tenant.default.shipment.cancel',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.cancel'
    ),
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_cancel_v1')
  )
),
(
  'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e730',
  '22222222-2222-4222-8222-222222222730',
  'Tenant shipment delete',
  TRUE,
  'DELETE',
  '/v1/orders/{shipmentId}/delete',
  'tenant',
  '11111111-1111-4111-8111-111111111730',
  jsonb_build_object(
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_delete_v1')
  )
),
(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb730',
  '22222222-2222-4222-8222-222222222730',
  'Global shipment create',
  TRUE,
  'POST',
  '/v1/orders/global',
  'global',
  NULL,
  jsonb_build_object(
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1')
  )
),
(
  'cccccccc-cccc-4ccc-8ccc-ccccccccc730',
  '22222222-2222-4222-8222-222222222730',
  'Other tenant shipment create',
  TRUE,
  'POST',
  '/v1/orders/other-tenant',
  'tenant',
  '11111111-1111-4111-8111-111111111731',
  jsonb_build_object(
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1')
  )
),
(
  '88888888-8888-4888-8888-888888888730',
  '22222222-2222-4222-8222-222222222730',
  'Unsupported mapping type route',
  TRUE,
  'POST',
  '/v1/orders/unsupported',
  'tenant',
  '11111111-1111-4111-8111-111111111730',
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '33333333-3333-4333-8333-333333333730',
      'mapping_type', 'webhook_inbound'
    ),
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1')
  )
)
ON CONFLICT (id) DO UPDATE
SET policy = EXCLUDED.policy,
    updated_at = now();

INSERT INTO public.api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeee0730',
  '22222222-2222-4222-8222-222222222730',
  'Runtime mapped shipment create',
  TRUE,
  'POST',
  '/v1/orders/mapped-runtime',
  'source',
  '34343434-3434-4343-8343-343434343730',
  '23232323-2323-4232-8232-232323232730',
  'POST',
  '/provider/orders',
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', '33333333-3333-4333-8333-333333333730',
      'mapping_key', 'tenant.default.shipment.create',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.create'
    ),
    'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30),
    'provider_account', jsonb_build_object('required', FALSE),
    'postprocess', jsonb_build_object('enabled', TRUE, 'mode', 'shipment_create_v1')
  )
)
ON CONFLICT (id) DO UPDATE
SET pack_id = EXCLUDED.pack_id,
    route_name = EXCLUDED.route_name,
    enabled = EXCLUDED.enabled,
    provider_id = EXCLUDED.provider_id,
    upstream_method = EXCLUDED.upstream_method,
    upstream_path_template = EXCLUDED.upstream_path_template,
    policy = EXCLUDED.policy,
    updated_at = now();

SELECT ok(
  to_regprocedure('public.api_gateway_route_request_mapping_v1(public.api_routes,uuid,uuid,uuid,uuid)') IS NOT NULL,
  'api_gateway_route_request_mapping_v1 exists'
);

SELECT ok(
  to_regprocedure('public.api_gateway_apply_request_mapping_v1(public.api_routes,uuid,uuid,uuid,uuid,jsonb)') IS NOT NULL,
  'api_gateway_apply_request_mapping_v1 exists'
);

SELECT ok(
  to_regprocedure('api.ui_upsert_api_gateway_route_mapping_v1(jsonb)') IS NOT NULL,
  'api wrapper exists for route mapping binding'
);

SELECT ok(
  to_regprocedure('public.api_gateway_mapping_target_intent_v1(text)') IS NOT NULL,
  'api_gateway_mapping_target_intent_v1 exists'
);

SELECT ok(
  to_regprocedure('public.api_gateway_mapping_intents_compatible_v1(text,text)') IS NOT NULL,
  'api_gateway_mapping_intents_compatible_v1 exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'mapping_type'
      AND v.value = 'api_gateway_inbound'
      AND v.status = 'active'
  ),
  'api_gateway_inbound mapping type lookup is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'mapping_target'
      AND v.value = 'shipments.create'
      AND COALESCE(v.metadata->'allowed_mapping_types', '[]'::jsonb) ? 'api_gateway_inbound'
  ),
  'shipments.create allows API Gateway inbound mapping configs'
);

SELECT is(
  public.api_gateway_mapping_target_intent_v1('shipments.cancel'),
  'shipment.delete',
  'mapping target helper normalizes plural cancel into shipment.delete intent'
);

SELECT is(
  public.api_gateway_mapping_target_intent_v1('shipments.create'),
  'shipment.create',
  'mapping target helper normalizes plural create into shipment.create intent'
);

SELECT is(
  public.api_gateway_mapping_target_intent_v1('shipments.update'),
  'shipment.update',
  'mapping target helper normalizes general update into shipment.update intent'
);

SELECT is(
  public.api_gateway_mapping_target_intent_v1('shipments.delete'),
  'shipment.delete',
  'mapping target helper normalizes explicit delete into shipment.delete intent'
);

SELECT ok(
  public.api_gateway_mapping_intents_compatible_v1('shipment.update', 'update.status'),
  'generic shipment update routes can accept typed update mapping targets'
);

SELECT is(
  public.redact_sensitive_json(jsonb_build_object('api_secret', 'body-secret'))->>'api_secret',
  'REDACTED',
  'sensitive JSON redaction covers api_secret request body fields'
);

SELECT is(
  public.redact_sensitive_json(jsonb_build_object('nested', jsonb_build_object('clientSecret', 'nested-secret'))) #>> '{nested,clientSecret}',
  'REDACTED',
  'sensitive JSON redaction covers camel-case secret request body fields'
);

SELECT is(
  public.api_gateway_shipment_mutation_default_workflow_template_v1('update.status'),
  'api_gateway_shipment_mutation_default_v1',
  'API Gateway update/status routes resolve to the typed shipment mutation workflow'
);

SELECT is(
  public.api_gateway_shipment_mutation_default_workflow_template_v1('shipment.delete'),
  'api_gateway_shipment_mutation_default_v1',
  'API Gateway cancel/delete routes resolve to the typed shipment mutation workflow'
);

SELECT is(
  (
    SELECT public.api_gateway_route_request_mapping_v1(
      r,
      '11111111-1111-4111-8111-111111111730',
      NULL,
      NULL,
      NULL
    )->>'mapping_config_id'
    FROM public.api_routes r
    WHERE r.id = '55555555-5555-4555-8555-555555555730'
  ),
  '33333333-3333-4333-8333-333333333730',
  'tenant default route resolves its request mapping config'
);

SELECT is(
  (
    SELECT public.api_gateway_route_request_mapping_v1(
      r,
      '11111111-1111-4111-8111-111111111730',
      '77777777-7777-4777-8777-777777777730',
      NULL,
      NULL
    )->>'mapping_key'
    FROM public.api_routes r
    WHERE r.id = '66666666-6666-4666-8666-666666666730'
  ),
  'client.exception.shipment.create',
  'client-scoped route resolves the client exception mapping config'
);

SELECT is(
  (
    SELECT public.api_gateway_apply_request_mapping_v1(
      r,
      '11111111-1111-4111-8111-111111111730',
      NULL,
      NULL,
      NULL,
      jsonb_build_object(
        'order', jsonb_build_object('id', 'EXT-730'),
        'customer', jsonb_build_object('name', 'Mapped Recipient', 'phone', '+966500000730')
      )
    ) #>> '{payload,shipment,client_reference}'
    FROM public.api_routes r
    WHERE r.id = '55555555-5555-4555-8555-555555555730'
  ),
  'EXT-730',
  'tenant default mapping transforms external order id into outbound payload'
);

SELECT is(
  (
    SELECT public.api_gateway_apply_request_mapping_v1(
      r,
      '11111111-1111-4111-8111-111111111730',
      '77777777-7777-4777-8777-777777777730',
      NULL,
      NULL,
      jsonb_build_object(
        'legacy', jsonb_build_object(
          'ref', 'LEG-730',
          'receiverName', 'Legacy Recipient',
          'receiverPhone', '+966500000731'
        )
      )
    ) #>> '{payload,recipient,name}'
    FROM public.api_routes r
    WHERE r.id = '66666666-6666-4666-8666-666666666730'
  ),
  'Legacy Recipient',
  'client exception mapping transforms the client-specific payload shape'
);

SELECT is(
  (
    SELECT public.api_gateway_apply_request_mapping_v1(
      r,
      '11111111-1111-4111-8111-111111111730',
      NULL,
      NULL,
      NULL,
      jsonb_build_object('tracking', 'TRK-730', 'state', 'delivered')
    ) #>> '{payload,shipment,status}'
    FROM public.api_routes r
    WHERE r.id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd730'
  ),
  'delivered',
  'shipment update mapping transforms external status payload before workflow dispatch'
);

SELECT is(
  (
    SELECT public.api_gateway_apply_request_mapping_v1(
      r,
      '11111111-1111-4111-8111-111111111730',
      NULL,
      NULL,
      NULL,
      jsonb_build_object('shipmentId', 'SHIP-730', 'cancel', jsonb_build_object('reason', 'customer_cancelled'))
    ) #>> '{payload,cancellation,reason}'
    FROM public.api_routes r
    WHERE r.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeee730'
  ),
  'customer_cancelled',
  'shipment cancel/delete mapping transforms external cancellation payload before workflow dispatch'
);

SELECT is(
  (
    SELECT public.api_gateway_apply_request_mapping_v1(
      r,
      '11111111-1111-4111-8111-111111111730',
      NULL,
      NULL,
      NULL,
      '{}'::jsonb
    )->>'ok'
    FROM public.api_routes r
    WHERE r.id = '88888888-8888-4888-8888-888888888730'
  ),
  'false',
  'unsupported request mapping type fails closed'
);

SELECT is(
  (
    SELECT public.api_gateway_apply_request_mapping_v1(
      r,
      '11111111-1111-4111-8111-111111111730',
      NULL,
      NULL,
      NULL,
      '{}'::jsonb
    )->>'error'
    FROM public.api_routes r
    WHERE r.id = '99999999-9999-4999-8999-999999999730'
  ),
  'mapping_target_mismatch',
  'mapping target mismatch fails closed before provider dispatch'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

SELECT is(
  (
    SELECT public.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', '11111111-1111-4111-8111-111111111730',
      'api_route_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa730',
      'mapping_config_id', '33333333-3333-4333-8333-333333333730'
    ))->>'mapping_config_id'
  ),
  '33333333-3333-4333-8333-333333333730',
  'route mapping binding RPC returns backend readback for tenant-owned route'
);

SELECT is(
  (
    SELECT policy #>> '{request_mapping,mapping_config_id}'
    FROM public.api_routes
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa730'
  ),
  '33333333-3333-4333-8333-333333333730',
  'route mapping binding persists same route policy readback'
);

SELECT is(
  (
    SELECT api.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', '11111111-1111-4111-8111-111111111730',
      'api_route_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa730',
      'mapping_config_id', '33333333-3333-4333-8333-333333333730'
    ))->>'mapping_key'
  ),
  'tenant.default.shipment.create',
  'api schema wrapper executes route mapping binding and returns backend readback'
);

SELECT is(
  (
    SELECT public.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', '11111111-1111-4111-8111-111111111730',
      'api_route_id', 'dddddddd-dddd-4ddd-8ddd-ddddddddd730',
      'mapping_config_id', '45454545-4545-4454-8454-454545454730'
    ))->>'mapping_key'
  ),
  'tenant.default.shipment.update_status',
  'route mapping binding supports shipment update API mappings'
);

SELECT is(
  (
    SELECT public.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', '11111111-1111-4111-8111-111111111730',
      'api_route_id', 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d730',
      'mapping_config_id', '47474747-4747-4474-8474-474747474730'
    ))->>'mapping_key'
  ),
  'tenant.default.shipment.update',
  'public route mapping binding supports general shipment update API mappings'
);

SELECT is(
  (
    SELECT api.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', '11111111-1111-4111-8111-111111111730',
      'api_route_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeee730',
      'mapping_config_id', '46464646-4646-4464-8464-464646464730'
    ))->>'mapping_key'
  ),
  'tenant.default.shipment.cancel',
  'api wrapper route mapping binding supports shipment cancel/delete API mappings'
);

SELECT is(
  (
    SELECT api.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', '11111111-1111-4111-8111-111111111730',
      'api_route_id', 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e730',
      'mapping_config_id', '48484848-4848-4484-8484-484848484730'
    ))->>'mapping_key'
  ),
  'tenant.default.shipment.delete',
  'api wrapper route mapping binding supports explicit shipment delete API mappings'
);

SELECT is(
  (
    SELECT policy #>> '{workflow,template_name}'
    FROM public.api_routes
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd730'
  ),
  'api_gateway_shipment_mutation_default_v1',
  'shipment update API routes are workflow-engine-first by default'
);

SELECT is(
  (
    SELECT policy #>> '{workflow,template_name}'
    FROM public.api_routes
    WHERE id = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e730'
  ),
  'api_gateway_shipment_mutation_default_v1',
  'shipment delete API routes are workflow-engine-first by default'
);

SELECT throws_like(
  $$
    SELECT public.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', '11111111-1111-4111-8111-111111111730',
      'api_route_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb730',
      'mapping_config_id', '33333333-3333-4333-8333-333333333730'
    ))
  $$,
  '%global route%',
  'tenant operators cannot bind request mappings onto service-managed global routes'
);

SELECT throws_like(
  $$
    SELECT public.ui_upsert_api_gateway_route_mapping_v1(jsonb_build_object(
      'organization_id', '11111111-1111-4111-8111-111111111730',
      'api_route_id', 'cccccccc-cccc-4ccc-8ccc-ccccccccc730',
      'mapping_config_id', '33333333-3333-4333-8333-333333333730'
    ))
  $$,
  '%not owned by organization%',
  'tenant operators cannot bind request mappings onto another tenant route'
);

CREATE TEMP TABLE tmp_api_gateway_mapping_runtime AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-mapping-730',
  'POST',
  '/v1/orders/mapped-runtime',
  '',
  jsonb_build_object(
    'content-type', 'application/json',
    'authorization', 'Bearer request-mapping-secret',
    'x-correlation-id', '99999999-9999-4999-8999-999999999731',
    'x-webhook-token', 'token-api-gateway-mapping-730'
  ),
  jsonb_build_object(
    'order', jsonb_build_object('id', 'EXT-RUNTIME-730'),
    'customer', jsonb_build_object('name', 'Runtime Mapped Recipient', 'phone', '+966500000732'),
    'password', 'request-body-secret'
  )
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_mapping_runtime),
  'accepted_async',
  'workflow intake accepts the route-bound request mapping path through workflow mode'
);

SELECT is(
  (
    SELECT agr.request_body->>'password'
    FROM public.api_gateway_requests agr
    WHERE agr.id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_mapping_runtime)
  ),
  'REDACTED',
  'api_gateway_requests keeps original request readback redacted'
);

CREATE TEMP TABLE tmp_api_gateway_mapping_progress_1 AS
SELECT public.progress_api_gateway_request_workflow_v1(
  (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_mapping_runtime),
  (SELECT (result->>'workflow_run_id')::uuid FROM tmp_api_gateway_mapping_runtime),
  '{}'::jsonb
) AS result;

CREATE TEMP TABLE tmp_api_gateway_mapping_progress_2 AS
SELECT public.progress_api_gateway_request_workflow_v1(
  (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_mapping_runtime),
  (SELECT (result->>'workflow_run_id')::uuid FROM tmp_api_gateway_mapping_runtime),
  '{}'::jsonb
) AS result;

SELECT is(
  (
    SELECT oc.body #>> '{shipment,client_reference}'
    FROM public.outbound_calls oc
    WHERE oc.id = (
      SELECT agr.outbound_call_id
      FROM public.api_gateway_requests agr
      WHERE agr.id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_mapping_runtime)
    )
  ),
  'EXT-RUNTIME-730',
  'workflow dispatch enqueues provider job with mapped outbound payload'
);

SELECT is(
  (
    SELECT oc.context #>> '{api_gateway_request_mapping,mapping_config_id}'
    FROM public.outbound_calls oc
    WHERE oc.id = (
      SELECT agr.outbound_call_id
      FROM public.api_gateway_requests agr
      WHERE agr.id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_mapping_runtime)
    )
  ),
  '33333333-3333-4333-8333-333333333730',
  'workflow-dispatched outbound call context carries request mapping lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log dl
    WHERE dl.resource_type = 'api_gateway_request'
      AND dl.resource_id = (SELECT (result->>'api_gateway_request_id')::uuid FROM tmp_api_gateway_mapping_runtime)
      AND dl.decision_point = 'api_gateway_request_mapping'
      AND dl.decision_outcome = 'applied'
      AND dl.decision_inputs #>> '{mapping,mapping_config_id}' = '33333333-3333-4333-8333-333333333730'
  ),
  'decision log records applied API Gateway request mapping lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'workflow_intake_api_gateway_v1'
      AND pg_get_functiondef(p.oid) LIKE '%api_gateway_apply_request_mapping_v1%'
      AND pg_get_functiondef(p.oid) LIKE '%v_safe_outbound_body%'
      AND pg_get_functiondef(p.oid) LIKE '%api_gateway_request_mapping%'
      AND pg_get_functiondef(p.oid) LIKE '%api_gateway_request_mapping_applied%'
      AND pg_get_functiondef(p.oid) LIKE '%p_decision_outcome := ''applied''%'
      AND pg_get_functiondef(p.oid) LIKE '%''request_body'', COALESCE(v_safe_outbound_body, v_safe_body, ''{}''::jsonb)%'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'workflow_handlers'
      AND p.proname = 'execute_api_gateway_dispatch_outbound_v1'
      AND pg_get_functiondef(p.oid) LIKE '%''api_gateway_request_mapping'', COALESCE(v_api->''api_gateway_request_mapping'', ''{}''::jsonb)%'
  ),
  'workflow intake and dispatch apply request mapping with outbound body, context lineage, and applied decision proof'
);

SELECT * FROM finish();

ROLLBACK;
