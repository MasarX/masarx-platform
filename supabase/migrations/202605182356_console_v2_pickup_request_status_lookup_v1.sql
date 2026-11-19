-- Console V2 pickup request lifecycle lookup.
-- The requests projection exposes shipment status values for pickup rows, so
-- the live lookup catalog must include the canonical shipment-backed aliases
-- alongside older UI filter values.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605182356_console_v2_pickup_request_status_lookup_v1'));
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
  'pickup_request_status',
  'Pickup request lifecycle status (api.pickup_requests_list_v1 projection) consumed by operate/pickups.tsx requests tab.',
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
    ('pending', 'Pending', 10, true, jsonb_build_object('tone', 'info', 'lifecycle', 'requested')),
    ('pickup_requested', 'Pickup requested', 11, false, jsonb_build_object('tone', 'info', 'lifecycle', 'requested')),
    ('scheduled', 'Scheduled', 20, false, jsonb_build_object('tone', 'info', 'lifecycle', 'scheduled')),
    ('pickup_scheduled', 'Pickup scheduled', 21, false, jsonb_build_object('tone', 'info', 'lifecycle', 'scheduled')),
    ('assigned', 'Assigned', 30, false, jsonb_build_object('tone', 'good', 'lifecycle', 'assigned')),
    ('completed', 'Completed', 40, false, jsonb_build_object('tone', 'good', 'lifecycle', 'completed', 'is_terminal', true)),
    ('failed', 'Failed', 50, false, jsonb_build_object('tone', 'danger', 'lifecycle', 'failed', 'is_terminal', true)),
    ('cancelled', 'Cancelled', 60, false, jsonb_build_object('tone', 'neutral', 'lifecycle', 'cancelled', 'is_terminal', true))
) AS v(value, label, sort_order, is_default, metadata)
  ON ld.category = 'pickup_request_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    retired_at = NULL,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605182356_console_v2_pickup_request_status_lookup_v1'));
COMMIT;
