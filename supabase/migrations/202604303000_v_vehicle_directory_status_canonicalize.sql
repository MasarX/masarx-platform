-- Spec-Issue: W35b — REAUDIT3 FLEET P1-1 closure
-- Step: W35b-VIEW-1
-- Migration: Canonicalize public.v_vehicle_directory.is_oos predicate.
-- Capability: fleet.read (read-only; underlying RLS enforced)
--
-- Background:
--   The original W29 view at supabase/migrations/202604302700_v_vehicle_directory.sql:174
--   derived `is_oos` from `v.status = 'out_of_service'`. The canonical
--   `mark_vehicle_oos_v1` RPC
--   (supabase/migrations/202604280020_mark_vehicle_oos_v1.sql:95) writes
--   `vehicles.status = 'oos'`, and the canonical `vehicle_status` lookup
--   catalog (`202601231000_fleet_foundation_v1.sql:35-38` + the additive
--   `'oos'` seed at `202604280020_mark_vehicle_oos_v1.sql:20`) is
--   `active|inactive|in_maintenance|retired|oos`. There is no canonical
--   `'out_of_service'` value, so the W29 boolean was structurally dead
--   against canonical wire data: `is_oos` always evaluated FALSE in
--   production, and the FE "Out of service" KPI tile silently reported 0.
--
-- Remediation:
--   Append-only migration that REPLACES the W29 view (PostgreSQL
--   `CREATE OR REPLACE VIEW`). The historical W29 migration file is left
--   untouched (append-only policy preserved). The replacement keeps every
--   other column/derivation intact and ONLY narrows the `is_oos` predicate
--   to the canonical lookup value `'oos'`.
--
-- Notes:
--   * SSOT remains public.vehicles; this view is read-only.
--   * RLS is enforced via security_invoker = true (preserved).
--   * GRANTs preserved (anon revoked; authenticated + service_role SELECT).
--   * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - Audit cite: apps/console-v2/__audit__/REAUDIT3/FLEET.md P1-1.
--   - Canonical lookup: 202601231000_fleet_foundation_v1.sql:35-38 +
--     202604280020_mark_vehicle_oos_v1.sql:20 (additive `'oos'` seed).
--   - Canonical RPC: 202604280020_mark_vehicle_oos_v1.sql:95 (writes 'oos').
--   - FE consumer: apps/console-v2/src/modules/operate/fleet/vehicles.tsx
--     KPI filter (also realigned in W35b to canonical 'oos').
--   - pgTAP coverage: supabase/tests/pgtap/zzw35b_v_vehicle_directory_status.sql.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604303000_v_vehicle_directory_status_canonicalize'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_vehicle_directory
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
  -- W35b — canonical OOS predicate. Was `v.status = 'out_of_service'` in
  -- the original W29 migration; rewritten to `v.status = 'oos'` to match
  -- the canonical `vehicle_status` lookup catalog and the value written by
  -- mark_vehicle_oos_v1.
  (v.status = 'oos')                                             AS is_oos,
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
  'FE-friendly projection of vehicles. W35b canonicalized is_oos to derive from status=''oos'' (canonical vehicle_status lookup value). Sources: vehicles + branches + vehicle_types + vehicle_assignments + vehicle_events + vehicle_maintenance_windows + users. Read-only; SSOT remains vehicles; mutations route through assign_driver_to_vehicle_v1 / unassign_driver_v1 / mark_vehicle_oos_v1 / restore_vehicle_v1 / schedule_maintenance_v1 / complete_maintenance_v1 / cancel_maintenance_v1 / record_vehicle_event_v1.';

REVOKE ALL ON public.v_vehicle_directory FROM PUBLIC;
REVOKE ALL ON public.v_vehicle_directory FROM anon;
GRANT SELECT ON public.v_vehicle_directory TO authenticated;
GRANT SELECT ON public.v_vehicle_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604303000_v_vehicle_directory_status_canonicalize'));
COMMIT;
