-- Spec-Issue: W20 NETWORK gap closure (paired projection views)
-- Step: W20-VIEW-1
-- Migration: Canonical projection view public.v_branch_zone_directory.
-- Capability: branches.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-branch_zones row labels (branch_label, hub_code, zone_label)
--   used by the FE network surfaces:
--     • /network/branches → drawer Zones tab (renders linked-zone chips with
--       branch-side labels for context)
--     • /network/zones    → drawer Branches tab (renders linked-branch
--       DataTable with branch_label column)
--
--   The FE row interface BranchZoneRow declares `branch_label` (a
--   FE-side join projection from `branches.name`), which is NOT a column
--   on canonical `public.branch_zones`. This view materialises the
--   projection so the FE can consume the canonical column directly via
--   `useResourceList<>('branch_zone_directory')` instead of inlining a
--   join in seed/render code.
--
-- Notes:
--   * SSOT remains public.branch_zones; this view is read-only.
--   * RLS is enforced by the underlying tables (branch_zones / branches /
--     zones). Tenant isolation comes from the underlying tables' SELECT
--     policies, which scope rows to caller's organization.
--   * Service-role + authenticated SELECT (mirrors v_branch_summary +
--     v_zone_summary baselines).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301801_v_branch_zone_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_branch_zone_directory;

CREATE VIEW public.v_branch_zone_directory
WITH (security_invoker = true)
AS
SELECT
  bz.id            AS id,
  bz.branch_id,
  bz.zone_id,
  bz.priority,
  bz.created_at,
  -- branch_label projection: prefer name, fall back to code so legacy seeds
  -- without a name still render a meaningful identifier.
  COALESCE(b.name, b.code) AS branch_label,
  b.code           AS hub_code,
  b.branch_type    AS branch_type,
  z.name           AS zone_label,
  z.slug           AS zone_slug
FROM public.branch_zones bz
LEFT JOIN public.branches b ON b.id = bz.branch_id
LEFT JOIN public.zones z    ON z.id = bz.zone_id;

COMMENT ON VIEW public.v_branch_zone_directory IS
  'FE-friendly projection of branch_zones with derived join columns (branch_label, hub_code, zone_label, branch_type). Sources: branch_zones + branches + zones. Read-only; SSOT remains branch_zones; mutations go through branch_zone_assign_v1 / branch_zone_unassign_v1.';

REVOKE ALL ON public.v_branch_zone_directory FROM PUBLIC;
REVOKE ALL ON public.v_branch_zone_directory FROM anon;
REVOKE ALL ON public.v_branch_zone_directory FROM authenticated;
GRANT SELECT ON public.v_branch_zone_directory TO authenticated;
GRANT SELECT ON public.v_branch_zone_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301801_v_branch_zone_directory'));
COMMIT;
