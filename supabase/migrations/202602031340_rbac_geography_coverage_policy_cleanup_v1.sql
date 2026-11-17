-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Remove legacy capability-based write policies for geography tables (zones, zone_districts)
--
-- Why
-- - pgTAP regression guard requires all control-plane authenticated write policies to be RBAC-gated via
--   public.user_has_permission_v1 (least-privilege, row-driven).
-- - Earlier migrations introduced RBAC policies (zones_write_policy / zone_districts_write_policy) but
--   left legacy capability-based policies (zones_insert/update/delete, zone_districts_*) in place.
-- - Multiple policies are OR-ed by Postgres RLS, so legacy policies weaken enforcement.
--
-- What
-- - Drop legacy capability-based authenticated policies for zones + zone_districts.
-- - Recreate RBAC policies (idempotent) to ensure stable write gates remain in place.
--
-- Notes
-- - Uses permission `agreements.write` (coverage/agreements semantics).
-- - Service role policies are unchanged.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602031340_rbac_geography_coverage_policy_cleanup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Zones: remove legacy policies; enforce RBAC gates
-------------------------------------------------------------------------------

-- Legacy capability policies (must not coexist with RBAC policies).
DROP POLICY IF EXISTS zones_select ON public.zones;
DROP POLICY IF EXISTS zones_insert ON public.zones;
DROP POLICY IF EXISTS zones_update ON public.zones;
DROP POLICY IF EXISTS zones_delete ON public.zones;

-- RBAC policies (recreate idempotently).
DROP POLICY IF EXISTS zones_select_policy ON public.zones;
CREATE POLICY zones_select_policy ON public.zones
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS zones_write_policy ON public.zones;
CREATE POLICY zones_write_policy ON public.zones
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- 2) Zone districts: remove legacy policies; enforce RBAC gates
-------------------------------------------------------------------------------

-- Legacy capability policies (must not coexist with RBAC policies).
DROP POLICY IF EXISTS zone_districts_select ON public.zone_districts;
DROP POLICY IF EXISTS zone_districts_insert ON public.zone_districts;
DROP POLICY IF EXISTS zone_districts_update ON public.zone_districts;
DROP POLICY IF EXISTS zone_districts_delete ON public.zone_districts;

-- RBAC policies (recreate idempotently).
DROP POLICY IF EXISTS zone_districts_select_policy ON public.zone_districts;
CREATE POLICY zone_districts_select_policy ON public.zone_districts
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR EXISTS (
      SELECT 1
      FROM public.zones z
      WHERE z.id = public.zone_districts.zone_id
        AND z.organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS zone_districts_write_policy ON public.zone_districts;
CREATE POLICY zone_districts_write_policy ON public.zone_districts
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', public.current_user_org_id())
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.zones z
        WHERE z.id = public.zone_districts.zone_id
          AND z.organization_id = public.current_user_org_id()
      )
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', public.current_user_org_id())
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.zones z
        WHERE z.id = zone_id
          AND z.organization_id = public.current_user_org_id()
      )
    )
  );

SELECT pg_advisory_unlock(hashtext('202602031340_rbac_geography_coverage_policy_cleanup_v1'));
COMMIT;

