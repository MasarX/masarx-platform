-- Spec-Issue: W29 FLEET gap closure (paired projection views)
-- Step: W29-VIEW-4
-- Migration: Canonical projection view public.v_vehicle_maintenance_directory.
-- Capability: fleet.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-window derived counters + label rollups used by
--   `apps/console-v2/src/modules/operate/fleet/vehicles.tsx` Maintenance tab
--   (MaintWindowRow shape).
--
--   Surfaces the W11-4 driver_profile_summary_v1 / vehicles_with_state_v1
--   pattern for the maintenance window lifecycle (status added in
--   202604280030_schedule_maintenance_v1 — scheduled / completed /
--   cancelled).
--
--   Derived columns:
--     - vehicle_label             : derived projection from vehicles.plate_number
--                                     (or vehicle_type.name when plate is
--                                     NULL).
--     - vehicle_type_label        : derived from vehicle_types.name.
--     - scheduled_by_label        : derived users.full_name JOIN on
--                                     scheduled_by_user_id (NULL when not
--                                     persisted).
--     - reason                    : passthrough.
--     - is_scheduled              : derived alias for status='scheduled'.
--     - is_completed              : derived alias for status='completed'.
--     - is_cancelled              : derived alias for status='cancelled'.
--     - is_in_progress            : derived BOOLEAN — TRUE when
--                                     status='scheduled' AND
--                                     window_start_at <= now() AND
--                                     window_end_at >= now().
--     - is_overdue                : derived BOOLEAN — TRUE when
--                                     status='scheduled' AND
--                                     window_end_at < now() (the operator
--                                     should have marked complete by now).
--     - is_terminal               : derived BOOLEAN — TRUE when status is
--                                     in ('completed','cancelled').
--     - age_seconds               : derived seconds since created_at.
--     - duration_seconds          : derived window_end_at - window_start_at
--                                     (BIGINT seconds).
--     - starts_in_seconds         : derived seconds until window_start_at
--                                     (NULL when already started; negative
--                                     when overdue).
--     - completed_age_seconds     : derived seconds since completed_at
--                                     (NULL when not completed).
--     - cancelled_age_seconds     : derived seconds since cancelled_at
--                                     (NULL when not cancelled).
--
--   Notes:
--     * SSOT remains public.vehicle_maintenance_windows; this view is
--       read-only.
--     * RLS is enforced by the underlying tables
--       (vehicle_maintenance_windows, vehicles, vehicle_types, users) via
--       security_invoker = true.
--     * Service-role + authenticated SELECT (mirrors W22-W28 paired
--       projection grants).
--     * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - SSOT inventory: apps/console-v2/__audit__/SCHEMA-DRIFT/FLEET.md §10
--   - FE shape: apps/console-v2/src/modules/operate/fleet/vehicles.tsx:177
--     (MaintWindowRow)
--   - Canonical table: 202601231000_fleet_foundation_v1.sql:309 (foundation)
--                       + 202604280030_schedule_maintenance_v1.sql:33 (status
--                       column extension).
--   - Mutation RPCs: schedule_maintenance_v1 / complete_maintenance_v1 /
--     cancel_maintenance_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302730_v_vehicle_maintenance_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_vehicle_maintenance_directory;

CREATE VIEW public.v_vehicle_maintenance_directory
  WITH (security_invoker = true)
  AS
SELECT
  vmw.id,
  vmw.organization_id,
  vmw.vehicle_id,
  vmw.window_start_at,
  vmw.window_end_at,
  vmw.reason,
  vmw.notes,
  vmw.status,
  vmw.scheduled_by_user_id,
  vmw.completed_at,
  vmw.cancelled_at,
  vmw.metadata,
  vmw.created_at,
  vmw.updated_at,
  -- Derived: vehicle label (canonical projection of vehicles.plate_number).
  v.plate_number                                                 AS vehicle_label,
  v.plate_number                                                 AS vehicle_plate,
  vt.name                                                        AS vehicle_type_label,
  -- Derived: scheduled_by label.
  u.full_name                                                    AS scheduled_by_label,
  u.email                                                        AS scheduled_by_email,
  -- Derived: lifecycle booleans (FE chip vocabulary).
  (vmw.status = 'scheduled')                                     AS is_scheduled,
  (vmw.status = 'completed')                                     AS is_completed,
  (vmw.status = 'cancelled')                                     AS is_cancelled,
  (vmw.status IN ('completed', 'cancelled'))                     AS is_terminal,
  (
    vmw.status = 'scheduled'
    AND vmw.window_start_at <= now()
    AND vmw.window_end_at >= now()
  )                                                              AS is_in_progress,
  (
    vmw.status = 'scheduled'
    AND vmw.window_end_at < now()
  )                                                              AS is_overdue,
  -- Derived: age + duration aggregates (BIGINT seconds; FE renders relative
  -- time chips).
  EXTRACT(EPOCH FROM (now() - vmw.created_at))::BIGINT           AS age_seconds,
  EXTRACT(EPOCH FROM (vmw.window_end_at - vmw.window_start_at))::BIGINT
                                                                 AS duration_seconds,
  CASE
    WHEN vmw.window_start_at <= now() THEN NULL
    ELSE EXTRACT(EPOCH FROM (vmw.window_start_at - now()))::BIGINT
  END                                                            AS starts_in_seconds,
  CASE
    WHEN vmw.completed_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - vmw.completed_at))::BIGINT
  END                                                            AS completed_age_seconds,
  CASE
    WHEN vmw.cancelled_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - vmw.cancelled_at))::BIGINT
  END                                                            AS cancelled_age_seconds
FROM public.vehicle_maintenance_windows vmw
LEFT JOIN public.vehicles v ON v.id = vmw.vehicle_id
LEFT JOIN public.vehicle_types vt ON vt.id = v.vehicle_type_id
LEFT JOIN public.users u ON u.id = vmw.scheduled_by_user_id;

COMMENT ON VIEW public.v_vehicle_maintenance_directory IS
  'FE-friendly projection of vehicle_maintenance_windows with vehicle + vehicle_type + scheduled_by label joins (vehicle_label / vehicle_type_label / scheduled_by_label / scheduled_by_email), derived lifecycle booleans (is_scheduled / is_completed / is_cancelled / is_terminal / is_in_progress / is_overdue), and derived age/duration aggregates in BIGINT seconds (age_seconds / duration_seconds / starts_in_seconds / completed_age_seconds / cancelled_age_seconds). Sources: vehicle_maintenance_windows + vehicles + vehicle_types + users. Read-only; SSOT remains vehicle_maintenance_windows; mutations route through schedule_maintenance_v1 / complete_maintenance_v1 / cancel_maintenance_v1.';

REVOKE ALL ON public.v_vehicle_maintenance_directory FROM PUBLIC;
REVOKE ALL ON public.v_vehicle_maintenance_directory FROM anon;
GRANT SELECT ON public.v_vehicle_maintenance_directory TO authenticated;
GRANT SELECT ON public.v_vehicle_maintenance_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302730_v_vehicle_maintenance_directory'));
COMMIT;
