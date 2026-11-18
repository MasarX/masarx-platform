-- Console V2 Mapping Studio target authoring must be row-driven.
--
-- The frontend create modal reads `mapping_target` lookup rows instead of
-- accepting arbitrary target text. These rows define the production-supported
-- mapping targets operators can select during first-tenant setup.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605091030_console_v2_mapping_target_lookup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  id,
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  created_at,
  updated_at
)
VALUES (
  gen_random_uuid(),
  'mapping_target',
  'Console V2 Mapping Studio target taxonomy for mapping_configs.mapping_config->target authoring.',
  'operations',
  'tier_1',
  false,
  now(),
  now()
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
   WHERE category = 'mapping_target'
),
seed(value, label, description, sort_order, is_default, metadata) AS (
  VALUES
    (
      'shipments.create',
      'Shipment create',
      'Normalize inbound payloads into canonical shipment creation.',
      10,
      true,
      '{"tone":"info","target_resource":"shipments","target_action":"create","allowed_mapping_types":["webhook_inbound","tabular_import"]}'::jsonb
    ),
    (
      'webhook_response',
      'Webhook response',
      'Build provider acknowledgement or callback response payloads.',
      20,
      false,
      '{"tone":"neutral","target_resource":"webhook_response","target_action":"build","allowed_mapping_types":["webhook_response","webhook_outbound"]}'::jsonb
    ),
    (
      'shipments.update_status',
      'Shipment status update',
      'Normalize provider status payloads into canonical shipment status updates.',
      30,
      false,
      '{"tone":"warn","target_resource":"shipments","target_action":"update_status","allowed_mapping_types":["provider_response","webhook_inbound"]}'::jsonb
    ),
    (
      'domain_events',
      'Domain event extraction',
      'Extract canonical domain events from inbound or workflow payloads.',
      40,
      false,
      '{"tone":"good","target_resource":"domain_events","target_action":"extract","allowed_mapping_types":["event_extraction"]}'::jsonb
    )
)
INSERT INTO public.lookup_values (
  id,
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  effective_from,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  definition.id,
  seed.value,
  seed.label,
  seed.description,
  seed.sort_order,
  seed.is_default,
  'active',
  seed.metadata,
  now(),
  now(),
  now()
FROM definition
CROSS JOIN seed
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = EXCLUDED.metadata,
    effective_from = COALESCE(public.lookup_values.effective_from, EXCLUDED.effective_from),
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605091030_console_v2_mapping_target_lookup_v1'));
COMMIT;
