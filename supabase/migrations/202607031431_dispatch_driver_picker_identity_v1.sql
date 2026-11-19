BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE VIEW public.driver_profile_picker_v1
WITH (security_invoker = true) AS
SELECT
  dp.user_id AS id,
  dp.organization_id,
  COALESCE(NULLIF(u.full_name, ''), NULLIF(driver.full_name, ''), u.email, driver.email, dp.driver_code, dp.user_id::text) AS name,
  dp.driver_code,
  NULLIF(dp.metadata->>'phone', '') AS phone,
  COALESCE(u.email, driver.email) AS user_email,
  dp.status,
  active_assignment.vehicle_id,
  '[]'::jsonb AS skills
FROM public.driver_profiles dp
LEFT JOIN public.users u
  ON u.id = dp.user_id
LEFT JOIN LATERAL public.fleet_driver_identity_v1(dp.organization_id, dp.user_id) driver
  ON u.id IS NULL
LEFT JOIN LATERAL (
  SELECT va.vehicle_id
  FROM public.vehicle_assignments va
  WHERE va.organization_id = dp.organization_id
    AND va.assigned_to_user_id = dp.user_id
    AND COALESCE(NULLIF(va.status, ''), 'active') = 'active'
    AND va.ended_at IS NULL
  ORDER BY va.started_at DESC NULLS LAST, va.created_at DESC, va.id DESC
  LIMIT 1
) AS active_assignment ON TRUE;

COMMIT;
