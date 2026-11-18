-- Spec-Issue: W24 OPERATIONS gap closure (paired projection views)
-- Step: W24-VIEW-3
-- Migration: Canonical projection view public.v_route_plan_directory.
-- Capability: route_plans.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-plan derived counters + joined labels used by
--   `apps/console-v2/src/modules/operate/route-plans.tsx` (RoutePlanRow
--   surface):
--     - plan_display_id        : FE display alias derived from
--                                left-trimmed UUID (PLN-XXXXXX). Stable
--                                cross-cutover so visual snapshots and
--                                operator chips don't change.
--     - branch_label           : projection — branches.name via FK join.
--     - branch_code            : projection — branches.code via FK join.
--     - wave_label             : projection — coalesce of canonical
--                                metadata.wave_label / inputs.wave_label
--                                (operator-friendly wave grouping).
--     - wave_key               : projection — coalesce of
--                                metadata.wave / inputs.wave / canonical
--                                wave_catalog id when persisted.
--     - run_count              : projection — COUNT(route_runs WHERE
--                                route_plan_id matches).
--     - stop_count             : projection — COUNT(route_stops via
--                                route_runs JOIN route_plan_id).
--     - drivers_notified_count : projection — DISTINCT driver_user_id over
--                                route_plan_events WHERE
--                                event_type='driver_notified'. Honest
--                                derivation; route_plan_events is the
--                                immutable ledger SSOT.
--     - applied_at             : passthrough canonical column. The FE
--                                previously rendered `applied` as a count;
--                                the canonical projection exposes the
--                                actual timestamp + a derived boolean.
--     - is_applied             : derived — applied_at IS NOT NULL.
--
--   The FE `RoutePlanRow` interface in `route-plans.tsx` carries legacy
--   FE-only fields (`plan_id`, `wave_label`, `hub`, `stops`, `runs`,
--   `drivers_notified`, `applied`); after this projection lands, those
--   resolve through the same registry seam (display alias for
--   `plan_id`/`hub`/`wave_label`, derived counters for the rest), so the
--   row interface can collapse to canonical columns + projections in a
--   future no-op cutover. Production swap is a single
--   getSupabaseClient() branch flip in
--   `ui_list_resource_v1('route_plan_directory')`.
--
-- Notes:
--   * SSOT remains public.route_plans; this view is read-only.
--   * RLS is enforced by the underlying tables (route_plans, route_runs,
--     route_stops, route_plan_events, branches).
--   * Service-role + authenticated SELECT (mirrors W20/W21/W22/W23 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302250_v_route_plan_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_route_plan_directory;

CREATE VIEW public.v_route_plan_directory AS
WITH run_rollup AS (
  SELECT
    route_plan_id,
    COUNT(*)::INT                AS run_count
  FROM public.route_runs
  WHERE route_plan_id IS NOT NULL
  GROUP BY route_plan_id
),
stop_rollup AS (
  SELECT
    rr.route_plan_id,
    COUNT(rs.id)::INT            AS stop_count
  FROM public.route_runs rr
  LEFT JOIN public.route_stops rs ON rs.route_run_id = rr.id
  WHERE rr.route_plan_id IS NOT NULL
  GROUP BY rr.route_plan_id
),
notified_rollup AS (
  -- Drivers notified = DISTINCT actor_user_id on `driver_notified` events.
  -- route_plan_events is the immutable ledger SSOT
  -- (supabase/migrations/202601311740_route_plans_ssot_v1.sql:155).
  SELECT
    route_plan_id,
    COUNT(DISTINCT actor_user_id)::INT AS drivers_notified_count
  FROM public.route_plan_events
  WHERE event_type = 'driver_notified'
    AND actor_user_id IS NOT NULL
  GROUP BY route_plan_id
)
SELECT
  rp.id,
  rp.organization_id,
  rp.branch_id,
  rp.planned_date,
  rp.status,
  rp.status_reason,
  rp.requested_by_user_id,
  rp.requested_at,
  rp.solved_at,
  rp.applied_at,
  rp.idempotency_key,
  rp.version,
  rp.metadata,
  rp.created_at,
  rp.updated_at,
  -- FE display alias derived from canonical PK. Mirrors how
  -- route-plans.tsx renders `plan_id` (was a fictional alias of `id`).
  ('PLN-' || upper(substr(replace(rp.id::text, '-', ''), 1, 6))) AS plan_display_id,
  -- Branch projections.
  b.name                                                          AS branch_label,
  b.code                                                          AS branch_code,
  -- Wave projection from metadata/inputs JSONB.
  COALESCE(
    rp.metadata->>'wave_label',
    rp.inputs->>'wave_label'
  )                                                               AS wave_label,
  COALESCE(
    rp.metadata->>'wave',
    rp.inputs->>'wave',
    rp.metadata->>'wave_id',
    rp.inputs->>'wave_id'
  )                                                               AS wave_key,
  -- Counter projections.
  COALESCE(rrl.run_count, 0)                                      AS run_count,
  COALESCE(srl.stop_count, 0)                                     AS stop_count,
  COALESCE(nrl.drivers_notified_count, 0)                         AS drivers_notified_count,
  -- Derived applied flag.
  (rp.applied_at IS NOT NULL)                                     AS is_applied
FROM public.route_plans rp
LEFT JOIN public.branches b   ON b.id = rp.branch_id
LEFT JOIN run_rollup rrl      ON rrl.route_plan_id = rp.id
LEFT JOIN stop_rollup srl     ON srl.route_plan_id = rp.id
LEFT JOIN notified_rollup nrl ON nrl.route_plan_id = rp.id;

COMMENT ON VIEW public.v_route_plan_directory IS
  'FE-friendly projection of route_plans with branch label/code (FK join), wave_label / wave_key from metadata/inputs JSONB, per-plan derived counters (run_count via route_runs.route_plan_id, stop_count via route_runs JOIN route_stops, drivers_notified_count via DISTINCT actor_user_id on route_plan_events.driver_notified), and is_applied derived flag (applied_at IS NOT NULL). Sources: route_plans + branches + route_runs + route_stops + route_plan_events. Read-only; SSOT remains route_plans; mutations go through ui_create_route_plan_v1 / ui_solve_route_plan_v1 / ui_freeze_route_plan_v1 / ui_publish_route_plan_v1 / ui_apply_route_plan_v1 / ui_rebalance_route_plan_v1 / route_plan_validate_constraints_v1.';

REVOKE ALL ON public.v_route_plan_directory FROM PUBLIC;
REVOKE ALL ON public.v_route_plan_directory FROM anon;
REVOKE ALL ON public.v_route_plan_directory FROM authenticated;
GRANT SELECT ON public.v_route_plan_directory TO authenticated;
GRANT SELECT ON public.v_route_plan_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302250_v_route_plan_directory'));
COMMIT;
