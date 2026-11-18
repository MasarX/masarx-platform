-- Repair v_route_run_directory so the current assignment projection follows
-- the current response lifecycle states. Refused assignments are terminal and
-- must not appear as the active assignment row in Console V2.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031660_route_run_directory_active_assignment_state_repair_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE VIEW public.v_route_run_directory
WITH (security_invoker = true)
AS
WITH stop_rollup AS (
  SELECT
    route_run_id,
    COUNT(*)::INT AS stop_count
  FROM public.route_stops
  GROUP BY route_run_id
),
cod_rollup AS (
  SELECT
    rs.route_run_id,
    SUM(COALESCE(s.cod_amount, 0))::NUMERIC AS cod_total
  FROM public.route_stops rs
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
  GROUP BY rs.route_run_id
),
active_assignment AS (
  SELECT DISTINCT ON (rra.route_run_id)
    rra.route_run_id,
    rra.id AS assignment_id,
    rra.assignment_status,
    rra.assignment_mode,
    rra.assignment_version,
    rra.driver_user_id AS assignment_driver_user_id,
    rra.vehicle_id AS assignment_vehicle_id,
    rra.partner AS assignment_partner,
    rra.assigned_at
  FROM public.route_run_assignments rra
  WHERE rra.assignment_status IN ('assigned', 'acknowledged', 'accepted')
  ORDER BY rra.route_run_id, rra.assignment_version DESC, rra.assigned_at DESC
)
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
  b.name AS branch_label,
  b.code AS branch_code,
  b.branch_type,
  COALESCE(u.full_name, u.email, rr.driver_user_id::text) AS driver_label,
  COALESCE(v.plate_number, v.vin, rr.vehicle_id::text) AS vehicle_label,
  COALESCE(sr.stop_count, 0) AS stop_count,
  COALESCE(cr.cod_total, 0) AS cod_total,
  aa.assignment_id,
  aa.assignment_status,
  aa.assignment_mode,
  aa.assignment_version,
  aa.assigned_at AS assignment_assigned_at,
  aa.assignment_driver_user_id,
  aa.assignment_vehicle_id,
  aa.assignment_partner AS partner_payload,
  COALESCE(
    aa.assignment_partner->>'partner_name',
    aa.assignment_partner->>'partner_id'
  ) AS partner_name,
  (aa.assignment_mode = 'partner_fleet') AS is_partner_run
FROM public.route_runs rr
LEFT JOIN public.branches b ON b.id = rr.branch_id
LEFT JOIN public.users u ON u.id = rr.driver_user_id
LEFT JOIN public.vehicles v ON v.id = rr.vehicle_id
LEFT JOIN stop_rollup sr ON sr.route_run_id = rr.id
LEFT JOIN cod_rollup cr ON cr.route_run_id = rr.id
LEFT JOIN active_assignment aa ON aa.route_run_id = rr.id;

COMMENT ON VIEW public.v_route_run_directory IS
  'FE-friendly projection of route_runs with branch/driver/vehicle labels, per-run counters, and current assignment projection from active route_run_assignments states only (assigned, acknowledged, accepted). Sources: route_runs + branches + users + vehicles + route_stops + shipments + route_run_assignments. Read-only; SSOT remains route_runs; mutations go through canonical assignment/reassignment RPCs.';

REVOKE ALL ON public.v_route_run_directory FROM PUBLIC;
REVOKE ALL ON public.v_route_run_directory FROM anon;
REVOKE ALL ON public.v_route_run_directory FROM authenticated;
GRANT SELECT ON public.v_route_run_directory TO authenticated;
GRANT SELECT ON public.v_route_run_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605031660_route_run_directory_active_assignment_state_repair_v1'));
COMMIT;
