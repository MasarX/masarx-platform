-- Console V2 pickup wave lifecycle lookup.
-- The Pickups waves tab renders route-run pickup waves through the live
-- lookup catalog; shared lanes must carry the same row-driven status contract
-- as seed data so Browser-backed proof does not depend on demo fallbacks.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605182355_console_v2_pickup_wave_status_lookup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'pickup_wave_status',
  'Pickup wave lifecycle status (api.pickup_waves_list_v1 projection) consumed by operate/pickups.tsx waves tab.',
  'operations',
  'tier_1',
  false
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
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata
FROM public.lookup_definitions ld
JOIN (
  VALUES
    (
      'planned',
      'Planned',
      10,
      true,
      jsonb_build_object('tone', 'neutral', 'is_assignable', true)
    ),
    (
      'assigned',
      'Assigned',
      20,
      false,
      jsonb_build_object('tone', 'info', 'is_assignable', false)
    ),
    (
      'in_progress',
      'In progress',
      30,
      false,
      jsonb_build_object('tone', 'info', 'is_assignable', false)
    ),
    (
      'completed',
      'Completed',
      40,
      false,
      jsonb_build_object('tone', 'good', 'is_assignable', false)
    ),
    (
      'cancelled',
      'Cancelled',
      50,
      false,
      jsonb_build_object('tone', 'neutral', 'is_assignable', false)
    )
) AS v(value, label, sort_order, is_default, metadata)
  ON ld.category = 'pickup_wave_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    retired_at = NULL,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605182355_console_v2_pickup_wave_status_lookup_v1'));
COMMIT;
