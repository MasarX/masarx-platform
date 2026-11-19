-- Spec-Issue: W29 FLEET gap closure (paired projection views)
-- Step: W29-VIEW-1
-- Migration: Canonical projection view public.v_vehicle_directory.
-- Capability: fleet.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-vehicle derived counters + label rollups used by
--   `apps/console-v2/src/modules/operate/fleet/vehicles.tsx` (VehicleRow shape):
--     - branch_label             : derived projection from branches.code +
--                                    branches.name (FE rendered via in-memory
--                                    map; surfaces canonical SSOT for the
--                                    `Branch` column).
--     - vehicle_type_label       : derived projection from vehicle_types.name
--                                    (FK join). Mirrors W11-4
--                                    `vehicles_with_state_v1.type_name` but
--                                    exposes both names so consumers can pin
--                                    on either alias.
--     - current_driver_user_id   : active vehicle_assignments.assigned_to_user_id
--                                    (only when status='active' and ended_at
--                                    is NULL). Mirrors W11-4
--                                    `vehicles_with_state_v1` semantics.
--     - current_driver_label     : derived users.full_name JOIN on the active
--                                    assignment user (NULL when unassigned).
--     - current_branch_id        : vehicles.branch_id (canonical column on
--                                    vehicles; the legacy FE field name was
--                                    `current_branch_id`).
--     - last_event_at            : derived MAX(vehicle_events.occurred_at) per
--                                    vehicle (closes W6/W10-2 telemetry
--                                    projection — FE rendered
--                                    `last_telemetry_at` derived from latest
--                                    telemetry event).
--     - event_count_24h          : derived COUNT(vehicle_events WHERE
--                                    occurred_at >= now() - INTERVAL '24 hours').
--     - maintenance_window_count : derived COUNT(vehicle_maintenance_windows)
--                                    per vehicle.
--     - active_maintenance_count : derived COUNT(vehicle_maintenance_windows
--                                    WHERE status='scheduled' AND
--                                    window_start_at <= now() AND
--                                    window_end_at >= now()).
--     - maintenance_due          : derived BOOLEAN — TRUE when there is a
--                                    scheduled window starting within 7 days
--                                    or already in progress.
--     - is_active                : alias for vehicles.is_active.
--     - is_oos                   : derived BOOLEAN — TRUE when status =
--                                    'out_of_service'.
--     - is_in_maintenance        : derived BOOLEAN — TRUE when status =
--                                    'in_maintenance' or there is an active
--                                    maintenance window.
--     - assignment_age_seconds   : derived seconds since the active
--                                    assignment.started_at (NULL when
--                                    unassigned).
--
--   The FE `VehicleRow` interface at apps/console-v2/src/modules/operate/
--   fleet/vehicles.tsx currently consumes the projection-shaped fields via
--   `_projectVehiclesWithState`. v_vehicle_directory unifies the existing
--   W11-4 projection with the additional counters + status booleans so the
--   FE can move per-row chip rendering (`mark_vehicle_oos` row action enable
--   condition, maintenance-due chip, last_ping freshness chip) onto the
--   canonical SSOT instead of synthesizing client-side.
--
-- Notes:
--   * SSOT remains public.vehicles; this view is read-only.
--   * RLS is enforced by the underlying tables (vehicles, vehicle_events,
--     vehicle_maintenance_windows, vehicle_assignments, vehicle_types,
--     branches, users) via security_invoker = true.
--   * Service-role + authenticated SELECT (mirrors W22-W28 paired projection
--     grants).
--   * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - SSOT inventory: apps/console-v2/__audit__/SCHEMA-DRIFT/FLEET.md §4 + §9
--   - FE shape: apps/console-v2/src/modules/operate/fleet/vehicles.tsx:100
--   - Canonical table: 202601231000_fleet_foundation_v1.sql:97
--   - Sibling view: 202604301440_vehicles_with_state_v1.sql (paired by
--     telemetry; this view extends with lifecycle + maintenance counters).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302700_v_vehicle_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_vehicle_directory;

CREATE VIEW public.v_vehicle_directory
  WITH (security_invoker = true)
  AS
WITH event_agg AS (
  SELECT
    ve.vehicle_id,
    MAX(ve.occurred_at)                                                   AS last_event_at,
    COUNT(*) FILTER (WHERE ve.occurred_at >= now() - INTERVAL '24 hours') AS event_count_24h
  FROM public.vehicle_events ve
  GROUP BY ve.vehicle_id
),
maint_agg AS (
  SELECT
    vmw.vehicle_id,
    COUNT(*)                                                              AS maintenance_window_count,
    COUNT(*) FILTER (
      WHERE vmw.status = 'scheduled'
        AND vmw.window_start_at <= now()
        AND vmw.window_end_at >= now()
    )                                                                     AS active_maintenance_count,
    BOOL_OR(
      vmw.status = 'scheduled'
      AND (
        (vmw.window_start_at <= now() AND vmw.window_end_at >= now())
        OR (vmw.window_start_at <= now() + INTERVAL '7 days' AND vmw.window_start_at >= now())
      )
    )                                                                     AS maintenance_due
  FROM public.vehicle_maintenance_windows vmw
  GROUP BY vmw.vehicle_id
),
active_assignment AS (
  SELECT DISTINCT ON (va.vehicle_id)
    va.vehicle_id,
    va.assigned_to_user_id,
    va.started_at,
    va.branch_id
  FROM public.vehicle_assignments va
  WHERE va.status = 'active'
    AND va.ended_at IS NULL
  ORDER BY va.vehicle_id, va.started_at DESC
)
SELECT
  v.id,
  v.organization_id,
  v.branch_id,
  v.vehicle_type_id,
  v.status,
  v.plate_number,
  v.plate_number_upper,
  v.vin,
  v.make,
  v.model,
  v.model_year,
  v.color,
  v.is_active,
  v.acquired_at,
  v.retired_at,
  v.metadata,
  v.created_at,
  v.updated_at,
  -- Derived: branch label (canonical projection of branches.code + name).
  CASE
    WHEN b.code IS NOT NULL AND b.name IS NOT NULL THEN b.code || ' · ' || b.name
    WHEN b.name IS NOT NULL THEN b.name
    WHEN b.code IS NOT NULL THEN b.code
    ELSE NULL
  END                                                            AS branch_label,
  -- Derived: vehicle_type label (canonical projection of vehicle_types.name).
  vt.name                                                        AS vehicle_type_label,
  vt.key                                                         AS vehicle_type_key,
  -- Derived: active assignment fields (NULL when unassigned).
  aa.assigned_to_user_id                                         AS current_driver_user_id,
  u.full_name                                                    AS current_driver_label,
  -- current_branch_id mirrors vehicles.branch_id (the static canonical column);
  -- callers needing the active-assignment branch should use aa.branch_id below.
  v.branch_id                                                    AS current_branch_id,
  aa.branch_id                                                   AS active_assignment_branch_id,
  aa.started_at                                                  AS active_assignment_started_at,
  CASE
    WHEN aa.started_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - aa.started_at))::BIGINT
  END                                                            AS assignment_age_seconds,
  -- Derived: telemetry/event aggregates.
  ea.last_event_at,
  COALESCE(ea.event_count_24h, 0)::INT                           AS event_count_24h,
  -- Derived: maintenance counters.
  COALESCE(ma.maintenance_window_count, 0)::INT                  AS maintenance_window_count,
  COALESCE(ma.active_maintenance_count, 0)::INT                  AS active_maintenance_count,
  COALESCE(ma.maintenance_due, FALSE)                            AS maintenance_due,
  -- Derived: status booleans (FE chip vocabulary).
  (v.status = 'out_of_service')                                  AS is_oos,
  (
    v.status = 'in_maintenance'
    OR COALESCE(ma.active_maintenance_count, 0) > 0
  )                                                              AS is_in_maintenance
FROM public.vehicles v
LEFT JOIN public.branches b ON b.id = v.branch_id
LEFT JOIN public.vehicle_types vt ON vt.id = v.vehicle_type_id
LEFT JOIN active_assignment aa ON aa.vehicle_id = v.id
LEFT JOIN public.users u ON u.id = aa.assigned_to_user_id
LEFT JOIN event_agg ea ON ea.vehicle_id = v.id
LEFT JOIN maint_agg ma ON ma.vehicle_id = v.id;

COMMENT ON VIEW public.v_vehicle_directory IS
  'FE-friendly projection of vehicles with branch + vehicle_type label joins (branch_label / vehicle_type_label), active assignment resolution (current_driver_user_id / current_driver_label / active_assignment_branch_id / assignment_age_seconds), telemetry aggregates (last_event_at / event_count_24h), maintenance counters (maintenance_window_count / active_maintenance_count / maintenance_due), and status booleans (is_oos / is_in_maintenance). Sources: vehicles + branches + vehicle_types + vehicle_assignments + vehicle_events + vehicle_maintenance_windows + users. Read-only; SSOT remains vehicles; mutations route through assign_driver_to_vehicle_v1 / unassign_driver_v1 / mark_vehicle_oos_v1 / restore_vehicle_v1 / schedule_maintenance_v1 / complete_maintenance_v1 / cancel_maintenance_v1 / record_vehicle_event_v1.';

REVOKE ALL ON public.v_vehicle_directory FROM PUBLIC;
REVOKE ALL ON public.v_vehicle_directory FROM anon;
GRANT SELECT ON public.v_vehicle_directory TO authenticated;
GRANT SELECT ON public.v_vehicle_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302700_v_vehicle_directory'));
COMMIT;
