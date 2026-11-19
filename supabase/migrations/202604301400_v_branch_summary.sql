-- Spec-Issue: W11-2 NETWORK gap closure (paired projection views)
-- Step: W11-2-VIEW-1
-- Migration: Canonical projection view public.v_branch_summary.
-- Capability: branches.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project the FE-derived branch operational counters used by
--   `apps/console-v2/src/modules/network/branches.tsx` (BranchRow):
--     - capacity_per_day  : aggregated from branch_capacity_windows.capacity
--                            JSONB (key: max_stops; sum across active windows
--                            for the branch).
--     - active_vehicles    : COUNT of vehicles where current branch_id matches
--                            and vehicle status='active'.
--     - active_routes      : COUNT of route_runs where branch_id matches and
--                            status IN ('planned','in_progress').
--     - manager_user_id    : MIN(user_id) over branch_memberships where
--                            role_key='manager' AND is_active=TRUE (deterministic
--                            single-pick when multiple managers exist).
--     - cutoff_time        : projected from branches.operating_hours JSONB
--                            (`cutoff_time_local`); NULL when not configured.
--     - updated_at         : passthrough from public.branches.
--
--   The FE `BranchRow` (apps/console-v2/src/modules/network/branches.tsx)
--   declares derived fields that are NOT columns on branches:
--   `capacity_per_day`, `booked_today`, `active_vehicles`, `active_routes`,
--   `manager_user_id`, `cutoff_time`. Those fields will be dropped in a
--   companion FE wave once the consuming UI has switched to `v_branch_summary`.
--
--   `booked_today` is intentionally NOT projected here: it depends on a
--   live "delivered_today" counter that the canonical contract does not
--   currently materialize (would require a window over today's deliveries).
--   FE retains the seeded synthetic value for now; a future migration
--   can extend this view once the live count is durable.
--
-- Notes:
--   * SSOT remains public.branches; this view is read-only.
--   * RLS is enforced by the underlying tables (branches /
--     branch_capacity_windows / vehicles / route_runs / branch_memberships).
--   * Service-role + authenticated SELECT (mirrors v_settlement_batch_summary
--     baseline). Tenant isolation comes from the underlying tables' SELECT
--     policies, which scope rows to caller's organization.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301400_v_branch_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_branch_summary;

CREATE VIEW public.v_branch_summary AS
WITH cap AS (
  -- Sum capacity.max_stops across all currently-active capacity windows for
  -- each branch. Matches FE seed semantics (capacity_per_day = sum of windowed
  -- capacity_units). When `capacity` JSONB lacks `max_stops`, treat as 0.
  SELECT
    bcw.branch_id,
    COALESCE(SUM(
      COALESCE((bcw.capacity->>'max_stops')::NUMERIC, 0)
    ), 0)::NUMERIC AS capacity_per_day
  FROM public.branch_capacity_windows bcw
  WHERE bcw.is_active = TRUE
    AND (bcw.effective_to IS NULL OR bcw.effective_to > now())
  GROUP BY bcw.branch_id
),
veh AS (
  -- Count vehicles currently assigned to this branch with status='active'.
  SELECT
    v.branch_id,
    COUNT(*)::INT AS active_vehicles
  FROM public.vehicles v
  WHERE v.branch_id IS NOT NULL
    AND v.is_active = TRUE
    AND v.status = 'active'
  GROUP BY v.branch_id
),
runs AS (
  -- Active route_runs anchored to this branch.
  SELECT
    rr.branch_id,
    COUNT(*)::INT AS active_routes
  FROM public.route_runs rr
  WHERE rr.branch_id IS NOT NULL
    AND rr.status IN ('planned', 'in_progress')
  GROUP BY rr.branch_id
),
mgr AS (
  -- Deterministic manager pick: MIN(user_id) over active manager memberships.
  -- Real production may resolve via priority/policy; baseline keeps a single
  -- predictable value so the FE can still display "the" manager.
  SELECT
    bm.branch_id,
    MIN(bm.user_id::TEXT)::UUID AS manager_user_id
  FROM public.branch_memberships bm
  WHERE bm.is_active = TRUE
    AND bm.role_key = 'manager'
    AND (bm.effective_to IS NULL OR bm.effective_to > now())
  GROUP BY bm.branch_id
)
SELECT
  b.id              AS branch_id,
  b.organization_id,
  b.code,
  b.name,
  b.branch_type,
  b.is_active,
  b.timezone,
  COALESCE(cap.capacity_per_day, 0)::NUMERIC AS capacity_per_day,
  COALESCE(veh.active_vehicles, 0)::INT      AS active_vehicles,
  COALESCE(runs.active_routes, 0)::INT       AS active_routes,
  mgr.manager_user_id,
  -- Cutoff time projected from operating_hours JSONB. SSOT contract:
  -- branches.operating_hours = {"cutoff_time_local":"HH:MM", ...}.
  -- NULL when unset; FE renders "—".
  NULLIF(btrim(COALESCE(b.operating_hours->>'cutoff_time_local', '')), '') AS cutoff_time,
  b.updated_at
FROM public.branches b
LEFT JOIN cap  ON cap.branch_id = b.id
LEFT JOIN veh  ON veh.branch_id = b.id
LEFT JOIN runs ON runs.branch_id = b.id
LEFT JOIN mgr  ON mgr.branch_id = b.id;

COMMENT ON VIEW public.v_branch_summary IS
  'FE-friendly projection of branches with derived counters (capacity_per_day, active_vehicles, active_routes, manager_user_id, cutoff_time). Sources: branches + branch_capacity_windows + vehicles + route_runs + branch_memberships. Read-only; SSOT remains branches; mutations go through branch_create_v1 / branch_update_v1 / mark_branch_oos_v1.';

-- Read access mirrors the underlying RLS posture: service-role baseline +
-- authenticated SELECT (so registry-driven `useResourceList` resolves through
-- the standard seam). Tenant isolation is enforced by the underlying tables'
-- SELECT policies.
REVOKE ALL ON public.v_branch_summary FROM PUBLIC;
REVOKE ALL ON public.v_branch_summary FROM anon;
REVOKE ALL ON public.v_branch_summary FROM authenticated;
GRANT SELECT ON public.v_branch_summary TO authenticated;
GRANT SELECT ON public.v_branch_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301400_v_branch_summary'));
COMMIT;
