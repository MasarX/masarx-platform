-- Plan: B08 Delivery proof & closeout / Step: E10
-- Migration: label target label_type lookup contract v1
-- Purpose:
--   - Extend the canonical label_type lookup so target-neutral route/container/
--     transfer label jobs can persist through the same lookup-enforced contract
--     used by shipment label jobs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101365_label_target_label_type_lookup_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  '{}'::jsonb
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('route', 'Route label', 'Target-neutral route_run label jobs.', 20),
    ('container', 'Container label', 'Target-neutral handling_unit label jobs.', 30),
    ('transfer', 'Transfer label', 'Target-neutral warehouse_transfer label jobs.', 40)
) AS v(value, label, description, sort_order)
  ON ld.category = 'label_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    metadata = EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202604101365_label_target_label_type_lookup_contract_v1'));

COMMIT;
