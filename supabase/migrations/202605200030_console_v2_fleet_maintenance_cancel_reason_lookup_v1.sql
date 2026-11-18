-- Console V2 fleet maintenance cancel action requires a row-driven default
-- reason before public.cancel_maintenance_v1 can be invoked from the UI.

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'maintenance_cancel_reason',
  'Canonical operator-selectable reasons for cancelling vehicle maintenance windows.',
  'fleet_ops',
  'none',
  false
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

WITH reason_lookup AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'maintenance_cancel_reason'
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
  reason_lookup.id,
  'operator_cancelled',
  'Operator cancelled',
  'Default operator-initiated cancellation reason for vehicle maintenance windows.',
  10,
  true,
  'active',
  jsonb_build_object('source', 'console_v2_fleet_maintenance')
FROM reason_lookup
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = EXCLUDED.status,
  metadata = EXCLUDED.metadata,
  updated_at = now();
