-- Spec-Issue: W24 OPERATIONS gap closure (paired projection views)
-- Step: W24-VIEW-2
-- Migration: Canonical projection view public.v_route_run_directory.
-- Capability: routes.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-run derived counters + joined labels used by
--   `apps/console-v2/src/modules/operate/dispatch.tsx` (RouteRunRow surface +
--   the dispatch insight rail):
--     - run_display_id   : FE display alias derived from left-trimmed UUID
--                          (RUN-XXXXXX). Mirrors the
--                          `runDisplayId(id)` helper exported from
--                          `apps/console-v2/src/modules/operate/dispatch.tsx`.
--     - branch_label     : projection — branches.name via FK join.
--     - branch_code      : projection — branches.code via FK join.
--     - driver_label     : projection — users.full_name via driver_user_id.
--     - vehicle_label    : projection — COALESCE(plate_number, vin, code)
--                          via vehicle_id.
--     - stop_count       : projection — COUNT(route_stops WHERE
--                          route_run_id matches).
--     - cod_total        : projection — SUM(shipments.cod_amount JOIN
--                          route_stops ON shipment_id) per run. Uses the
--                          canonical `shipments.cod_amount` so the COD
--                          float chip on dispatch matches the canonical
--                          ladder-resolved totals.
--     - assignment_status / assignment_mode / assignment_version :
--                          projection — current row from
--                          public.route_run_assignments where
--                          assignment_status IS NOT 'cancelled'
--                          (canonical W9-4 surface). NULL when no active
--                          assignment.
--     - partner_name     : projection — partner.partner_name from the
--                          assignment row's `partner` JSONB blob.
--     - is_partner_run   : derived — TRUE when assignment_mode =
--                          'partner_fleet'.
--
--   The FE `RouteRunRow` interface in `dispatch.tsx` reads canonical
--   columns directly (W14-1 byte-aligned the row interface). This
--   projection co-exposes the operator-facing display labels and counters
--   on the same registry seam so the FE can drop the per-render lookup
--   maps once cutover lands. Production cutover is a single
--   getSupabaseClient() branch flip in
--   `ui_list_resource_v1('route_run_directory')`.
--
-- Notes:
--   * SSOT remains public.route_runs; this view is read-only.
--   * RLS is enforced by the underlying tables (route_runs, route_stops,
--     route_run_assignments, branches, vehicles, users, shipments).
--   * Service-role + authenticated SELECT (mirrors W20/W21/W22/W23 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302240_v_route_run_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_route_run_directory;

CREATE VIEW public.v_route_run_directory AS
WITH stop_rollup AS (
  SELECT
    route_run_id,
    COUNT(*)::INT                AS stop_count
  FROM public.route_stops
  GROUP BY route_run_id
),
cod_rollup AS (
  -- Canonical COD float aggregation: route_stops -> shipments.cod_amount
  -- joined on (id, client_id) per the partition contract on
  -- public.shipments.
  SELECT
    rs.route_run_id,
    SUM(COALESCE(s.cod_amount, 0))::NUMERIC  AS cod_total
  FROM public.route_stops rs
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
  GROUP BY rs.route_run_id
),
active_assignment AS (
  -- Most-recent non-cancelled assignment per run. The W9-4 surface
  -- currently filters by `assignment_status <> 'cancelled'` and treats
  -- the highest assignment_version as authoritative.
  SELECT DISTINCT ON (rra.route_run_id)
    rra.route_run_id,
    rra.id                                      AS assignment_id,
    rra.assignment_status,
    rra.assignment_mode,
    rra.assignment_version,
    rra.driver_user_id                          AS assignment_driver_user_id,
    rra.vehicle_id                              AS assignment_vehicle_id,
    rra.partner                                 AS assignment_partner,
    rra.assigned_at
  FROM public.route_run_assignments rra
  WHERE rra.assignment_status IS DISTINCT FROM 'cancelled'
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
  -- FE display alias derived from canonical PK. Mirrors
  -- `runDisplayId(id)` in dispatch.tsx for stable cross-cutover labels.
  ('RUN-' || upper(substr(replace(rr.id::text, '-', ''), 1, 6))) AS run_display_id,
  -- Branch projections.
  b.name                                                          AS branch_label,
  b.code                                                          AS branch_code,
  b.branch_type,
  -- Driver projection (NULL when no driver assigned). FE prefers full_name
  -- but falls back to email then user id stub via COALESCE.
  COALESCE(u.full_name, u.email, rr.driver_user_id::text)         AS driver_label,
  -- Vehicle projection — the canonical operator chip prefers plate_number,
  -- then VIN, then a synthesized code from id.
  COALESCE(
    v.plate_number,
    v.vin,
    rr.vehicle_id::text
  )                                                               AS vehicle_label,
  -- Counter projections.
  COALESCE(sr.stop_count, 0)                                      AS stop_count,
  COALESCE(cr.cod_total, 0)                                       AS cod_total,
  -- Assignment projection.
  aa.assignment_id,
  aa.assignment_status,
  aa.assignment_mode,
  aa.assignment_version,
  aa.assigned_at                                                  AS assignment_assigned_at,
  aa.assignment_driver_user_id,
  aa.assignment_vehicle_id,
  aa.assignment_partner                                            AS partner_payload,
  COALESCE(
    aa.assignment_partner->>'partner_name',
    aa.assignment_partner->>'partner_id'
  )                                                               AS partner_name,
  (aa.assignment_mode = 'partner_fleet')                          AS is_partner_run
FROM public.route_runs rr
LEFT JOIN public.branches b   ON b.id = rr.branch_id
LEFT JOIN public.users u      ON u.id = rr.driver_user_id
LEFT JOIN public.vehicles v   ON v.id = rr.vehicle_id
LEFT JOIN stop_rollup sr      ON sr.route_run_id = rr.id
LEFT JOIN cod_rollup cr       ON cr.route_run_id = rr.id
LEFT JOIN active_assignment aa ON aa.route_run_id = rr.id;

COMMENT ON VIEW public.v_route_run_directory IS
  'FE-friendly projection of route_runs with branch/driver/vehicle labels (FK joins via branches.name, users.full_name, vehicles.plate_number), per-run derived counters (stop_count via route_stops, cod_total via shipments.cod_amount), and current assignment projection (assignment_status, assignment_mode, assignment_version, partner_name) from route_run_assignments. Sources: route_runs + branches + users + vehicles + route_stops + shipments + route_run_assignments. Read-only; SSOT remains route_runs; mutations go through ui_execute_route_run_assign_v1 / ui_execute_route_stop_reassign_v1 / ui_confirm_route_run_departure_v1 / route_run_scan_out_reconciliation_v1.';

REVOKE ALL ON public.v_route_run_directory FROM PUBLIC;
REVOKE ALL ON public.v_route_run_directory FROM anon;
REVOKE ALL ON public.v_route_run_directory FROM authenticated;
GRANT SELECT ON public.v_route_run_directory TO authenticated;
GRANT SELECT ON public.v_route_run_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302240_v_route_run_directory'));
COMMIT;
