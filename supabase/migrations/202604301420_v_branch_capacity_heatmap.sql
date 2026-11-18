-- Spec-Issue: W18-3 NETWORK gap closure (paired projection views)
-- Step: W18-3-VIEW-1
-- Migration: Canonical projection view public.v_branch_capacity_heatmap.
-- Capability: branches.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project the FE-derived heatmap cell shape used by
--   `apps/console-v2/src/modules/network/branches.tsx` (BranchCapacityRow):
--     - weekday        : canonical day_of_week (SMALLINT 0..6)
--     - hour           : per-hour fan-out across [window_start_local, window_end_local)
--     - capacity_units : projected from capacity JSONB (max_stops preferred,
--                        with max_units / max_cod_shipments / max_volume_m3
--                        fallbacks; 0 when none of those keys exist)
--     - booked_units   : NULL placeholder (live "booked today" counter is not
--                        yet materialised; FE renders 0 when null)
--
--   Canonical SSOT: `public.branch_capacity_windows`
--   (`supabase/migrations/202601212700_branch_capacity_catalog.sql:297-321`).
--   That table stores capacity rows as
--   `(branch_id, zone_id, day_of_week, window_start_local TIME,
--     window_end_local TIME, capacity JSONB, …)`. The FE heatmap surface needs
--   per-hour cells so the 7×24 grid renders without re-aggregating ranges in
--   JS — this view fans the `[start, end)` time range into one row per hour
--   inside the range. Rows where the range is open-ended (NULL start/end) are
--   skipped, matching the canonical "all-day baseline lives elsewhere"
--   contract from the foundation migration.
--
--   `booked_units` remains intentionally NULL: the canonical schema does not
--   yet expose a live "booked-against-window" counter. FE consumers treat
--   NULL as 0 so the heatmap intensity collapses to 0% (no warm cell) for
--   un-projected ranges. A future migration can add a paired
--   `compute_branch_capacity_load_v1` RPC and surface it here.
--
-- Notes:
--   * SSOT remains public.branch_capacity_windows; this view is read-only.
--   * RLS is enforced by the underlying table (branch_capacity_windows).
--   * Service-role + authenticated SELECT (mirrors v_branch_summary baseline).
--   * Idempotent: pure view; safe to re-run.
--   * The `id` field is synthesized as `<window_id>_<hour>` so the FE keeps
--     stable per-cell keys and existing test ids (`bcw_<branch>_<weekday>_<hour>`
--     style) keep working when a follow-up wave aligns id formatting.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301420_v_branch_capacity_heatmap'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_branch_capacity_heatmap;

CREATE VIEW public.v_branch_capacity_heatmap AS
WITH active AS (
  SELECT
    bcw.id,
    bcw.branch_id,
    bcw.zone_id,
    bcw.day_of_week,
    bcw.window_start_local,
    bcw.window_end_local,
    bcw.capacity,
    bcw.is_active,
    bcw.priority,
    bcw.updated_at
  FROM public.branch_capacity_windows bcw
  WHERE bcw.is_active = TRUE
    AND bcw.day_of_week IS NOT NULL
    AND bcw.window_start_local IS NOT NULL
    AND bcw.window_end_local IS NOT NULL
    AND (bcw.effective_to IS NULL OR bcw.effective_to > now())
),
expanded AS (
  -- Fan the [window_start_local, window_end_local) range into per-hour rows.
  -- The CHECK constraint on the source table already guarantees end > start,
  -- so the generate_series is well-defined. The end is exclusive (`< end_hour`).
  SELECT
    a.id AS source_window_id,
    a.branch_id,
    a.zone_id,
    a.day_of_week,
    h.hour::INT AS hour,
    a.capacity,
    a.priority,
    a.updated_at
  FROM active a
  CROSS JOIN LATERAL generate_series(
    EXTRACT(HOUR FROM a.window_start_local)::INT,
    EXTRACT(HOUR FROM a.window_end_local)::INT - 1,
    1
  ) AS h(hour)
)
SELECT
  -- Synthesise a deterministic per-cell id so the FE can use it as a row key
  -- and the heatmap click-handler can resolve cells back to the source window
  -- via `source_window_id` when needed.
  (e.source_window_id::TEXT || '_' || e.hour::TEXT) AS id,
  e.source_window_id,
  e.branch_id,
  e.zone_id,
  e.day_of_week                  AS weekday,
  e.hour                         AS hour,
  -- Project capacity_units from the canonical capacity JSONB. Prefer
  -- `max_stops` (matches v_branch_summary semantics), then `max_units`
  -- (matches branch_capacity_window_set_v1 convenience write), then
  -- `max_cod_shipments` and `max_volume_m3` as historical fallbacks. Returns
  -- 0 when none of those keys exist so the FE heatmap does not divide by
  -- NaN.
  COALESCE(
    NULLIF(e.capacity->>'max_stops', '')::NUMERIC,
    NULLIF(e.capacity->>'max_units', '')::NUMERIC,
    NULLIF(e.capacity->>'max_cod_shipments', '')::NUMERIC,
    NULLIF(e.capacity->>'max_volume_m3', '')::NUMERIC,
    0
  )::NUMERIC                     AS capacity_units,
  -- booked_units remains NULL until a paired live counter ships. FE treats
  -- NULL as 0 for intensity calculations.
  NULL::NUMERIC                  AS booked_units,
  e.priority,
  e.updated_at
FROM expanded e;

COMMENT ON VIEW public.v_branch_capacity_heatmap IS
  'FE-friendly heatmap projection of branch_capacity_windows: fans (day_of_week, [window_start_local, window_end_local)) into per-hour cells with (weekday, hour, capacity_units). booked_units is reserved (NULL) until a live counter is wired. Read-only; SSOT remains public.branch_capacity_windows.';

REVOKE ALL ON public.v_branch_capacity_heatmap FROM PUBLIC;
REVOKE ALL ON public.v_branch_capacity_heatmap FROM anon;
REVOKE ALL ON public.v_branch_capacity_heatmap FROM authenticated;
GRANT SELECT ON public.v_branch_capacity_heatmap TO authenticated;
GRANT SELECT ON public.v_branch_capacity_heatmap TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301420_v_branch_capacity_heatmap'));
COMMIT;
