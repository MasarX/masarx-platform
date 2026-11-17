-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Add missing mapping_domain lookup values used by field_mappings (fixup)
-- Rationale:
--   - `field_mappings.mapping_domain` is contract-enforced via lookup_values (category=mapping_domain).
--   - Multiple integrations map delivery semantics (service_type, shipment_status); these must be valid lookup values.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    ('service_type', 'Service Type', 'Service type mappings (delivery, return, swap, etc.)', 70),
    ('shipment_status', 'Shipment Status', 'Shipment status taxonomy mappings (provider/external -> canonical)', 80)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'mapping_domain'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

