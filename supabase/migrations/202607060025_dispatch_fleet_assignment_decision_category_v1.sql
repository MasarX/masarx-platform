-- Migration: Dispatch fleet assignment decision category v1
-- Date: 2026-07-06
--
-- Keep Dispatch proof setup and fleet assignment RPCs aligned with the
-- lookup-enforced decision_log contract. assign_driver_to_vehicle_v1 emits
-- fleet.driver_assigned, so the category must be seeded before proof setup
-- creates a vehicle assignment.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202607060025_dispatch_fleet_assignment_decision_category_v1'));
SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status
)
SELECT
  ld.id,
  category.value,
  category.label,
  category.description,
  category.sort_order,
  false,
  'active'
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  (
    'fleet.driver_assigned',
    'Fleet Driver Assigned',
    'Vehicle-driver assignment decisions emitted by assign_driver_to_vehicle_v1.',
    146
  )
) AS category(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    updated_at = now();

COMMIT;
