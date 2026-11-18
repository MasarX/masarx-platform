-- Console V2 Driver Applications request-docs lookup repair.
--
-- The Driver Applications drawer reads requestable document kinds from the
-- canonical lookup catalog. Drifted live databases can miss this category,
-- which leaves the request-additional-docs modal with no selectable values and
-- blocks the backend-backed review action.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605210945_console_v2_driver_application_doc_kind_lookup_v1'));

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
  'driver_application_doc_kind',
  'Driver application document kind taxonomy consumed by Console V2 Driver Applications request-docs review.',
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
      ('license', 'Driver license', 'License document required for driver onboarding.', 10, false, jsonb_build_object('tone', 'info')),
      ('national_id', 'National ID', 'National identity document required for driver onboarding.', 20, false, jsonb_build_object('tone', 'info')),
      ('medical', 'Medical certificate', 'Medical clearance document required for driver onboarding.', 30, true, jsonb_build_object('tone', 'info')),
      ('vehicle_inspection', 'Vehicle inspection', 'Vehicle inspection document required for vehicle-backed driver onboarding.', 40, false, jsonb_build_object('tone', 'info')),
      ('insurance', 'Insurance', 'Insurance document required for vehicle-backed driver onboarding.', 50, false, jsonb_build_object('tone', 'info')),
      ('hazmat_endorsement', 'Hazmat endorsement', 'Hazmat endorsement required when the driver requests restricted goods capability.', 60, false, jsonb_build_object('tone', 'warn'))
  ) AS v(value, label, description, sort_order, is_default, metadata)
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
JOIN lookup_rows r ON d.category = 'driver_application_doc_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = EXCLUDED.metadata,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605210945_console_v2_driver_application_doc_kind_lookup_v1'));

COMMIT;
