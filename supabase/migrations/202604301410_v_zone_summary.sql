-- Spec-Issue: W11-2 NETWORK gap closure (paired projection views)
-- Step: W11-2-VIEW-2
-- Migration: Canonical projection view public.v_zone_summary.
-- Capability: zones.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project the FE-derived zone counters used by
--   `apps/console-v2/src/modules/network/zones.tsx` (NetworkZoneRow):
--     - branch_count       : COUNT of distinct branches linked through
--                             public.branch_zones (canonical mapping table).
--     - district_count     : COUNT of zone_districts assigned to this zone
--                             (canonical baseline mapping).
--     - pending_overrides  : COUNT of zone_override_requests where status =
--                             'pending' for this zone (current_zone_id or
--                             requested_zone_id matches).
--     - last_override_at   : MAX(updated_at) over zone_override_requests for
--                             this zone (NULL when none).
--     - hub_code           : projected branches.code for the first linked
--                             branch by priority (deterministic pick).
--     - color_token        : passthrough from zones.metadata->>'color_token'
--                             (null when not set; FE falls back to neutral).
--     - updated_at         : passthrough from public.zones.
--
--   The FE `NetworkZoneRow` declares derived fields that are NOT columns on
--   zones (see __audit__/SCHEMA-DRIFT/NETWORK.md §7): `color_token`,
--   `geometry`, `hub_code`, `notes`. `notes` is the existing `description`
--   column rename; `geometry` stays FE-synthetic (no canonical polygon table);
--   `color_token` and `hub_code` are now projected here.
--
-- Notes:
--   * SSOT remains public.zones; this view is read-only.
--   * RLS is enforced by the underlying tables (zones / zone_districts /
--     branch_zones / branches / zone_override_requests).
--   * Service-role + authenticated SELECT (mirrors v_settlement_batch_summary
--     and v_branch_summary baselines).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301410_v_zone_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_zone_summary;

CREATE VIEW public.v_zone_summary AS
WITH br AS (
  -- COUNT of branches mapped to each zone via canonical branch_zones. Note
  -- branch_zones.zone_id is UNIQUE per the canonical baseline, but we still
  -- use COUNT(DISTINCT branch_id) so future evolution to N:M mapping does
  -- not require a view rewrite.
  SELECT
    bz.zone_id,
    COUNT(DISTINCT bz.branch_id)::INT AS branch_count
  FROM public.branch_zones bz
  GROUP BY bz.zone_id
),
br_pri AS (
  -- Deterministic hub_code projection: pick the lowest-priority branch
  -- linked to the zone (priority NULL last, then ascending). When multiple
  -- branches tie, pick smallest branch UUID for stability.
  SELECT DISTINCT ON (bz.zone_id)
    bz.zone_id,
    b.code AS hub_code
  FROM public.branch_zones bz
  JOIN public.branches b ON b.id = bz.branch_id
  ORDER BY bz.zone_id,
           bz.priority NULLS LAST,
           bz.branch_id::TEXT
),
dist AS (
  SELECT
    zd.zone_id,
    COUNT(*)::INT AS district_count
  FROM public.zone_districts zd
  GROUP BY zd.zone_id
),
ov AS (
  -- Aggregate zone override requests per zone. We treat both
  -- `current_zone_id` and `requested_zone_id` as zone references and union
  -- them so a pending override request that names the zone in either FK
  -- shows up in its summary counters.
  SELECT
    zone_id,
    COUNT(*) FILTER (WHERE status = 'pending')::INT AS pending_overrides,
    MAX(updated_at)                               AS last_override_at
  FROM (
    SELECT requested_zone_id AS zone_id, status, updated_at
      FROM public.zone_override_requests
     WHERE requested_zone_id IS NOT NULL
    UNION ALL
    SELECT current_zone_id AS zone_id, status, updated_at
      FROM public.zone_override_requests
     WHERE current_zone_id IS NOT NULL
  ) AS u
  GROUP BY zone_id
)
SELECT
  z.id           AS zone_id,
  z.organization_id,
  z.name,
  z.slug,
  z.is_active,
  z.description,
  z.created_at,
  z.updated_at,
  COALESCE(br.branch_count, 0)::INT     AS branch_count,
  COALESCE(dist.district_count, 0)::INT AS district_count,
  COALESCE(ov.pending_overrides, 0)::INT AS pending_overrides,
  ov.last_override_at,
  br_pri.hub_code,
  -- color_token is convention-only; projected from metadata when set.
  NULLIF(btrim(COALESCE(z.metadata->>'color_token', '')), '') AS color_token
FROM public.zones z
LEFT JOIN br     ON br.zone_id     = z.id
LEFT JOIN br_pri ON br_pri.zone_id = z.id
LEFT JOIN dist   ON dist.zone_id   = z.id
LEFT JOIN ov     ON ov.zone_id     = z.id;

COMMENT ON VIEW public.v_zone_summary IS
  'FE-friendly projection of zones with derived counters (branch_count, district_count, pending_overrides, last_override_at, hub_code, color_token). Sources: zones + branch_zones + branches + zone_districts + zone_override_requests. Read-only; SSOT remains zones; mutations go through zone_create_v1 / zone_district_add_v1 / zone_district_remove_v1 / suspend_zone_v1.';

REVOKE ALL ON public.v_zone_summary FROM PUBLIC;
REVOKE ALL ON public.v_zone_summary FROM anon;
REVOKE ALL ON public.v_zone_summary FROM authenticated;
GRANT SELECT ON public.v_zone_summary TO authenticated;
GRANT SELECT ON public.v_zone_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301410_v_zone_summary'));
COMMIT;
