-- Spec-Issue: W11-4 FLEET projection RPCs (paired with D4 schema-drift drops)
-- Step: W11-4-VIEW-2
-- Migration: Canonical projection view public.vehicles_with_state_v1.
-- Capability: fleet.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-vehicle "live state" rows for the FE `VehicleRow` (full
--   variant) shape (apps/console-v2/src/modules/operate/fleet/vehicles.tsx)
--   that does not have direct canonical columns:
--     - current_driver_user_id : active vehicle_assignments.assigned_to_user_id.
--     - current_branch_id      : active vehicle_assignments.branch_id (else
--                                 vehicles.branch_id).
--     - fuel_level             : projection from latest fuel-tagged
--                                 vehicle_event metadata fraction.
--     - odometer_km            : MAX(vehicle_events.odometer_km) per vehicle.
--     - last_telemetry_at      : MAX(vehicle_events.occurred_at).
--     - type_name              : projection (vehicle_types.name JOIN).
--
--   Sources: public.vehicles + public.vehicle_assignments + public.vehicle_events
--   + public.vehicle_types. SSOT remains vehicles; this view is read-only.
--
-- Notes:
--   * RLS is enforced by the underlying tables (vehicles + vehicle_assignments
--     + vehicle_events + vehicle_types). Projection view is service-only
--     baseline; FE consumes via the resource registry seam.
--   * `fuel_level` is sourced from the latest `event_type='fuel'` vehicle_event
--     `metadata->>'fuel_fraction'` (preferred) or `fuel_liters / capacity_liters`
--     (fallback). When neither is available, the column is NULL.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301420_vehicles_with_state_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.vehicles_with_state_v1;

CREATE VIEW public.vehicles_with_state_v1 AS
WITH active_assignment AS (
  -- Latest active driver assignment per vehicle.
  SELECT DISTINCT ON (va.vehicle_id)
    va.vehicle_id,
    va.assigned_to_user_id AS current_driver_user_id,
    va.branch_id           AS active_branch_id,
    va.started_at          AS assignment_started_at
  FROM public.vehicle_assignments va
  WHERE va.status = 'active'
    AND va.ended_at IS NULL
  ORDER BY va.vehicle_id, va.started_at DESC
),
latest_telemetry AS (
  -- Latest event timestamp + odometer per vehicle (any event_type).
  SELECT
    ve.vehicle_id,
    MAX(ve.occurred_at)               AS last_telemetry_at,
    MAX(ve.odometer_km)               AS odometer_km
  FROM public.vehicle_events ve
  GROUP BY ve.vehicle_id
),
latest_fuel AS (
  -- Most recent fuel event per vehicle for fuel_level projection.
  SELECT DISTINCT ON (ve.vehicle_id)
    ve.vehicle_id,
    ve.metadata,
    ve.fuel_liters,
    ve.occurred_at AS fuel_event_at
  FROM public.vehicle_events ve
  WHERE ve.event_type = 'fuel'
  ORDER BY ve.vehicle_id, ve.occurred_at DESC
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
  v.metadata        AS vehicle_metadata,
  v.created_at,
  v.updated_at,

  -- Type projections (vehicle_types JOIN)
  vt.key            AS type_key,
  vt.name           AS type_name,
  vt.metadata       AS type_metadata,

  -- Active assignment projections
  aa.current_driver_user_id,
  COALESCE(aa.active_branch_id, v.branch_id) AS current_branch_id,
  aa.assignment_started_at,

  -- Telemetry projections
  lt.last_telemetry_at,
  lt.odometer_km,

  -- Fuel level projection: prefer metadata->>'fuel_fraction' (0..1) when
  -- present, else compute from latest fuel_liters / capacity_liters (when
  -- the type carries a capacity hint). NULL when neither path is available.
  COALESCE(
    NULLIF(btrim(lf.metadata->>'fuel_fraction'), '')::NUMERIC,
    CASE
      WHEN lf.fuel_liters IS NOT NULL
       AND NULLIF(btrim(vt.metadata->>'fuel_capacity_liters'), '')::NUMERIC IS NOT NULL
       AND NULLIF(btrim(vt.metadata->>'fuel_capacity_liters'), '')::NUMERIC > 0
      THEN LEAST(
        1::NUMERIC,
        lf.fuel_liters / NULLIF(btrim(vt.metadata->>'fuel_capacity_liters'), '')::NUMERIC
      )
      ELSE NULL
    END
  )                  AS fuel_level,
  lf.fuel_event_at   AS last_fuel_event_at
FROM public.vehicles v
LEFT JOIN public.vehicle_types vt
  ON vt.id = v.vehicle_type_id
LEFT JOIN active_assignment aa
  ON aa.vehicle_id = v.id
LEFT JOIN latest_telemetry lt
  ON lt.vehicle_id = v.id
LEFT JOIN latest_fuel lf
  ON lf.vehicle_id = v.id;

COMMENT ON VIEW public.vehicles_with_state_v1 IS
  'FE-friendly projection of vehicles with derived (current_driver_user_id, current_branch_id, fuel_level, odometer_km, last_telemetry_at, type_name). Sources: vehicles + vehicle_types + vehicle_assignments + vehicle_events. Read-only; SSOT remains vehicles; mutations go through assign_driver_to_vehicle_v1 / unassign_driver_v1 / mark_vehicle_oos_v1 / restore_vehicle_v1 / record_vehicle_event_v1.';

REVOKE ALL ON public.vehicles_with_state_v1 FROM PUBLIC;
REVOKE ALL ON public.vehicles_with_state_v1 FROM anon;
REVOKE ALL ON public.vehicles_with_state_v1 FROM authenticated;
GRANT SELECT ON public.vehicles_with_state_v1 TO authenticated;
GRANT SELECT ON public.vehicles_with_state_v1 TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301420_vehicles_with_state_v1'));
COMMIT;
