BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE VIEW public.driver_profile_picker_v1
WITH (security_invoker = true) AS
SELECT
  dp.user_id AS id,
  dp.organization_id,
  COALESCE(
    NULLIF(u.full_name, ''),
    CASE WHEN u.id IS NULL THEN NULLIF(public.fleet_driver_display_name_v1(dp.organization_id, dp.user_id), '') END,
    u.email, dp.driver_code, dp.user_id::text
  ) AS name,
  dp.driver_code,
  CASE WHEN u.id IS NOT NULL THEN NULLIF(dp.metadata->>'phone', '') END AS phone,
  u.email AS user_email,
  dp.status,
  active_assignment.vehicle_id,
  '[]'::jsonb AS skills
FROM public.driver_profiles dp
LEFT JOIN LATERAL public.scoped_user_label_v1(dp.organization_id, dp.user_id) u ON TRUE
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

CREATE OR REPLACE VIEW public.v_route_run_directory
WITH (security_invoker = true) AS
SELECT
  rr.id,
  rr.organization_id,
  rr.branch_id,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.status,
  rr.planned_date,
  rr.planned_start_at,
  rr.planned_end_at,
  rr.started_at,
  rr.ended_at,
  rr.metadata,
  rr.created_at,
  rr.updated_at,
  ('RUN-' || upper(substr(replace(rr.id::text, '-', ''), 1, 6))) AS run_display_id,
  CASE
    WHEN b.id IS NULL THEN NULL
    WHEN NULLIF(b.code, '') IS NOT NULL AND NULLIF(b.name, '') IS NOT NULL THEN b.code || ' · ' || b.name
    ELSE COALESCE(NULLIF(b.name, ''), NULLIF(b.code, ''))
  END AS branch_label,
  b.code AS branch_code,
  b.branch_type,
  COALESCE(NULLIF(u.full_name, ''), u.email, rr.driver_user_id::text) AS driver_label,
  COALESCE(NULLIF(v.plate_number, ''), v.vin, rr.vehicle_id::text) AS vehicle_label,
  COALESCE(stop_counts.stop_count, 0)::int AS stop_count,
  COALESCE(stop_counts.cod_total, 0)::numeric AS cod_total,
  NULLIF(active_assignment.value->>'route_run_assignment_id', '')::uuid AS assignment_id,
  NULLIF(active_assignment.value->>'assignment_status', '') AS assignment_status,
  NULLIF(active_assignment.value->>'assignment_mode', '') AS assignment_mode,
  NULLIF(active_assignment.value->>'assignment_version', '')::int AS assignment_version,
  NULLIF(active_assignment.value->>'assigned_at', '')::timestamptz AS assignment_assigned_at,
  NULLIF(active_assignment.value->>'driver_user_id', '')::uuid AS assignment_driver_user_id,
  NULLIF(active_assignment.value->>'vehicle_id', '')::uuid AS assignment_vehicle_id,
  NULLIF(COALESCE(active_assignment.value->'partner', '{}'::jsonb), '{}'::jsonb) AS partner_payload,
  COALESCE(
    NULLIF(active_assignment.value#>>'{partner,partner_name}', ''),
    NULLIF(active_assignment.value#>>'{partner,partner_id}', '')
  ) AS partner_name,
  NULLIF(active_assignment.value->>'assignment_mode', '') IN ('partner_fleet', 'alternate_capacity_pool') AS is_partner_run
FROM api.route_runs rr
-- The shared readback retains the refused state. The directory describes active assignments.
LEFT JOIN LATERAL (
  SELECT rr.route_assignment AS value
  WHERE rr.route_assignment->>'assignment_status' IN ('assigned', 'acknowledged', 'accepted')
) AS active_assignment ON TRUE
LEFT JOIN public.branches b
  ON b.id = rr.branch_id
LEFT JOIN LATERAL public.scoped_user_label_v1(rr.organization_id, rr.driver_user_id) u ON TRUE
LEFT JOIN public.vehicles v
  ON v.id = rr.vehicle_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int AS stop_count,
    COALESCE(SUM(COALESCE(rs.cod_amount, 0)), 0)::numeric AS cod_total
  FROM api.route_stops rs
  WHERE rs.route_run_id = rr.id
) AS stop_counts ON TRUE;

COMMIT;
