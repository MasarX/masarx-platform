-- Console V2 webhook source lookup rows.
--
-- The Webhook sources screen resolves provider, enabled, and health labels
-- through lookup_definitions / lookup_values in live mode. Keep these values
-- row-driven so the frontend never falls back to table names, literals, or
-- "Unknown" chips for the first-tenant intake setup path.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'webhook_provider_type',
    'Webhook provider types for webhook source intake configuration.',
    'engineering',
    'tier_1',
    false
  ),
  (
    'enabled_state',
    'Generic enabled/disabled lifecycle taxonomy for operator toggles.',
    'engineering',
    'tier_1',
    false
  ),
  (
    'webhook_source_health',
    'Webhook source health-state taxonomy for Console V2 source monitoring.',
    'operations',
    'tier_1',
    false
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

WITH lookup_rows AS (
  SELECT *
  FROM (
    VALUES
      ('webhook_provider_type', 'shopify', 'Shopify', 'Provider source type for Shopify webhook payloads.', 10, false, '{"tone":"info"}'::jsonb),
      ('webhook_provider_type', 'woocommerce', 'WooCommerce', 'Provider source type for WooCommerce webhook payloads.', 20, false, '{"tone":"info"}'::jsonb),
      ('webhook_provider_type', 'generic', 'Generic JSON', 'Provider source type for generic JSON webhook payloads.', 30, true, '{"tone":"neutral"}'::jsonb),
      ('webhook_provider_type', 'custom_erp', 'Custom ERP', 'Provider source type for custom ERP webhook payloads.', 40, false, '{"tone":"neutral"}'::jsonb),
      ('webhook_provider_type', 'delivery_provider', 'Delivery provider', 'Provider source type for downstream delivery partner webhook payloads.', 50, false, '{"tone":"warn"}'::jsonb),
      ('enabled_state', 'enabled', 'Enabled', 'Operator-facing enabled state.', 10, true, '{"tone":"good"}'::jsonb),
      ('enabled_state', 'disabled', 'Disabled', 'Operator-facing disabled state.', 20, false, '{"tone":"neutral"}'::jsonb),
      ('webhook_source_health', 'healthy', 'Healthy', 'Webhook source is receiving events without recent errors.', 10, true, '{"tone":"good"}'::jsonb),
      ('webhook_source_health', 'degraded', 'Degraded', 'Webhook source has recent errors.', 20, false, '{"tone":"danger"}'::jsonb),
      ('webhook_source_health', 'idle', 'Idle', 'Webhook source has no recent healthy traffic and no recent errors.', 30, false, '{"tone":"neutral"}'::jsonb)
  ) AS v(category, value, label, description, sort_order, is_default, metadata)
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
  d.id,
  r.value,
  r.label,
  r.description,
  r.sort_order,
  r.is_default,
  'active',
  r.metadata
FROM public.lookup_definitions d
JOIN lookup_rows r
  ON r.category = d.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = now();

COMMIT;
