BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

-- Dispatch added assignment aliases. Fleet still reads the telemetry and maintenance fields.
CREATE OR REPLACE VIEW public.v_vehicle_directory
WITH (security_invoker = true) AS
WITH event_agg AS (
  SELECT
    ve.vehicle_id,
    MAX(ve.occurred_at)                                                   AS last_event_at,
    MAX(ve.occurred_at) FILTER (
      WHERE ve.odometer_km IS NOT NULL OR ve.fuel_liters IS NOT NULL
    )                                                                     AS last_telemetry_at,
    COUNT(*) FILTER (WHERE ve.occurred_at >= now() - INTERVAL '24 hours') AS event_count_24h
  FROM public.vehicle_events ve
  GROUP BY ve.vehicle_id
),
latest_odometer AS (
  SELECT DISTINCT ON (ve.vehicle_id)
    ve.vehicle_id,
    ve.odometer_km
  FROM public.vehicle_events ve
  WHERE ve.odometer_km IS NOT NULL
  ORDER BY ve.vehicle_id, ve.occurred_at DESC, ve.created_at DESC, ve.id DESC
),
latest_fuel AS (
  SELECT DISTINCT ON (ve.vehicle_id)
    ve.vehicle_id,
    CASE
      WHEN COALESCE(ve.metadata->>'fuel_fraction', '') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN LEAST(1, GREATEST(0, (ve.metadata->>'fuel_fraction')::NUMERIC))
      ELSE NULL
    END AS fuel_fraction,
    ve.fuel_liters,
    ve.occurred_at AS last_fuel_event_at
  FROM public.vehicle_events ve
  WHERE ve.fuel_liters IS NOT NULL
     OR COALESCE(ve.metadata->>'fuel_fraction', '') ~ '^[0-9]+(\.[0-9]+)?$'
  ORDER BY ve.vehicle_id, ve.occurred_at DESC, ve.created_at DESC, ve.id DESC
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
)
SELECT
  v.id,
  v.organization_id,
  v.branch_id,
  v.vehicle_type_id,
  v.status,
  v.plate_number,
  v.plate_number AS plate,
  v.plate_number AS code,
  v.vin,
  v.make,
  v.model,
  v.model_year,
  v.color,
  v.is_active,
  v.metadata,
  v.created_at,
  v.updated_at,
  vt.name AS vehicle_type_label,
  vt.name AS type_name,
  vt.key AS vehicle_type_key,
  active_assignment.assigned_to_user_id AS current_driver_user_id,
  COALESCE(NULLIF(driver_user.full_name, ''), driver_user.email) AS current_driver_label,
  COALESCE(active_assignment.branch_id, v.branch_id) AS current_branch_id,
  active_assignment.branch_id AS active_assignment_branch_id,
  active_assignment.started_at AS active_assignment_started_at,
  CASE
    WHEN active_assignment.started_at IS NULL THEN NULL
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - active_assignment.started_at)))::int
  END AS assignment_age_seconds,
  CASE
    WHEN b.id IS NULL THEN NULL
    WHEN NULLIF(b.code, '') IS NOT NULL AND NULLIF(b.name, '') IS NOT NULL THEN b.code || ' · ' || b.name
    ELSE COALESCE(NULLIF(b.name, ''), NULLIF(b.code, ''))
  END AS branch_label,
  (v.status = 'oos') AS is_oos,
  (v.status = 'in_maintenance' OR COALESCE(ma.active_maintenance_count, 0) > 0) AS is_in_maintenance,
  v.plate_number_upper,
  v.acquired_at,
  v.retired_at,
  ea.last_event_at,
  COALESCE(ea.event_count_24h, 0)::int AS event_count_24h,
  COALESCE(ma.maintenance_window_count, 0)::int AS maintenance_window_count,
  COALESCE(ma.active_maintenance_count, 0)::int AS active_maintenance_count,
  COALESCE(ma.maintenance_due, FALSE) AS maintenance_due,
  ea.last_telemetry_at,
  lo.odometer_km,
  COALESCE(
    lf.fuel_fraction,
    CASE
      WHEN lf.fuel_liters IS NOT NULL
        AND COALESCE(vt.metadata->>'fuel_capacity_liters', '') ~ '^[0-9]+(\.[0-9]+)?$'
        AND (vt.metadata->>'fuel_capacity_liters')::numeric > 0
        THEN LEAST(1, GREATEST(0, lf.fuel_liters / (vt.metadata->>'fuel_capacity_liters')::numeric))
      ELSE NULL
    END,
    0
  ) AS fuel_level,
  lf.last_fuel_event_at
FROM public.vehicles v
LEFT JOIN public.vehicle_types vt
  ON vt.id = v.vehicle_type_id
LEFT JOIN public.branches b
  ON b.id = v.branch_id
LEFT JOIN LATERAL (
  SELECT va.assigned_to_user_id, va.branch_id, va.started_at
  FROM public.vehicle_assignments va
  WHERE va.organization_id = v.organization_id
    AND va.vehicle_id = v.id
    AND COALESCE(NULLIF(va.status, ''), 'active') = 'active'
    AND va.ended_at IS NULL
  ORDER BY va.started_at DESC NULLS LAST, va.created_at DESC, va.id DESC
  LIMIT 1
) AS active_assignment ON TRUE
LEFT JOIN LATERAL public.scoped_user_label_v1(v.organization_id, active_assignment.assigned_to_user_id) driver_user
  ON TRUE
LEFT JOIN event_agg ea ON ea.vehicle_id = v.id
LEFT JOIN latest_odometer lo ON lo.vehicle_id = v.id
LEFT JOIN latest_fuel lf ON lf.vehicle_id = v.id
LEFT JOIN maint_agg ma ON ma.vehicle_id = v.id;

COMMENT ON VIEW public.v_vehicle_directory
  IS 'Invoker projection for Dispatch and Fleet, including latest telemetry, active assignment, and maintenance status.';

COMMIT;
