-- Driver, vehicle, and route assignment readiness lookup repair.
-- Keeps first-tenant Console proof row-driven for vehicle assignment chips and
-- driver document upload decision logging.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606111200_driver_vehicle_route_assignment_readiness_lookup_rows_v1'));
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
  'vehicle_assignment_state',
  'Vehicle assignment lifecycle states',
  'operations',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = FALSE,
    updated_at = now();

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
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  (
    'active',
    'Active',
    'Vehicle assignment currently active',
    10,
    TRUE,
    '{"domain":"fleet","tone":"good","is_active":true}'
  ),
  (
    'historical',
    'Historical',
    'Vehicle assignment ended and retained for audit history',
    20,
    FALSE,
    '{"domain":"fleet","tone":"neutral","is_active":false}'
  )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_assignment_state'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    retired_at = NULL,
    metadata = EXCLUDED.metadata,
    updated_at = now();

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
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  (
    'compliance.driver_document_uploaded',
    'Compliance Driver Document Uploaded',
    'Driver document upload decisions',
    755,
    '{"domain":"compliance","resource_type":"driver_document","operation":"upload"}'
  )
) AS v(value, label, description, sort_order, metadata)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    retired_at = NULL,
    metadata = EXCLUDED.metadata,
    updated_at = now();

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
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  (
    'submitted',
    'Submitted',
    'Record submitted for downstream review or verification',
    645,
    '{"domain":"operations"}'
  )
) AS v(value, label, description, sort_order, metadata)
WHERE ld.category = 'decision_outcome'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    retired_at = NULL,
    metadata = EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202606111200_driver_vehicle_route_assignment_readiness_lookup_rows_v1'));
COMMIT;
