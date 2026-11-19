-- Migration: Console V2 route-run assignment status lookup alias v1
-- Purpose:
--   - Align Dispatch insight-card lookup reads with the route_run_assignments
--     assignment_status values written by the canonical route assignment RPCs.
--   - Keep Console V2 row-driven status labels/tone from falling back to
--     "missing" when assignment rows are read live through ui_read_registry.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605072050_route_run_assignment_status_lookup_alias_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'route_run_assignment_status',
  'Route run assignment lifecycle status projected by route_run_assignments.assignment_status for Console V2 dispatch.',
  'dispatch',
  'tier_1',
  TRUE
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata, status)
SELECT
  ld.id,
  seeded.value,
  seeded.label,
  seeded.description,
  seeded.sort_order,
  seeded.is_default,
  seeded.metadata::jsonb,
  'active'
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    ('assigned', 'Assigned', 'Assignment created and awaiting downstream acknowledgement.', 10, TRUE,  '{"tone":"info"}'),
    ('accepted', 'Accepted', 'Assignment accepted by the executor.', 20, FALSE, '{"tone":"good"}'),
    ('acknowledged', 'Acknowledged', 'Assignment acknowledged as seen by the executor.', 30, FALSE, '{"tone":"info"}'),
    ('refused', 'Refused', 'Assignment refused and awaiting reassignment.', 40, FALSE, '{"tone":"danger"}')
) AS seeded(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'route_run_assignment_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  status = 'active',
  retired_at = NULL,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605072050_route_run_assignment_status_lookup_alias_v1'));
COMMIT;
