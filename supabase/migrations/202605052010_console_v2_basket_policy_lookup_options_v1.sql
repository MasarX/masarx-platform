-- Console V2 basket policy editor lookup options.
-- Keeps basket-policy form controls row-driven instead of frontend literals.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605052010_console_v2_basket_policy_lookup_options_v1'));

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'basket_policy_service_match_field',
    'Service discriminator fields allowed by basket_policy grouping.',
    'operations',
    'tier_1',
    true
  ),
  (
    'basket_policy_route_key_path',
    'Route discriminator paths allowed by basket_policy grouping.',
    'operations',
    'tier_1',
    true
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata,
  status
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb,
  'active'
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    (
      'service_level',
      'Service level',
      'Group baskets by the resolved service level.',
      10,
      true,
      '{"source_field":"service_level_id"}'
    ),
    (
      'service_type',
      'Service type',
      'Group baskets by the shipment service type.',
      20,
      false,
      '{"source_field":"service_type"}'
    ),
    (
      'service_level_or_type',
      'Service level, then type',
      'Prefer service level and fall back to service type.',
      30,
      false,
      '{"fallback_order":["service_level_id","service_type"]}'
    )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'basket_policy_service_match_field'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    metadata = EXCLUDED.metadata,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata,
  status
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb,
  'active'
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    (
      'routing.route_key',
      'Shipment route key',
      'Use the route key resolved during shipment routing.',
      10,
      true,
      '{"source":"shipment_routing"}'
    ),
    (
      'dispatch.route_key',
      'Dispatch route key',
      'Use the route key resolved by dispatch context.',
      20,
      false,
      '{"source":"dispatch_context"}'
    )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'basket_policy_route_key_path'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    metadata = EXCLUDED.metadata,
    status = EXCLUDED.status,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605052010_console_v2_basket_policy_lookup_options_v1'));

COMMIT;
