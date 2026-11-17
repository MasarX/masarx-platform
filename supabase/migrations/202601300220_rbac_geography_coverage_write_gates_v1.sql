-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC gates for geography + coverage write paths v1
-- Date: 2026-01-30
--
-- Why:
--   - Zones + branch-zone mapping define coverage and SLA applicability.
--   - Prior baseline allowed any tenant-scoped writer to mutate these tables.
--   - Enforce least-privilege by requiring RBAC permission `agreements.write` for authenticated writes.
--
-- Notes:
--   - Reads remain org-scoped (no breaking change for existing read paths).
--   - service_role policies remain authoritative for automation/workflows.
--   - Uses stable predicate `user_has_permission_v1` (row-driven; no hardcoded app roles).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300220_rbac_geography_coverage_write_gates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Coverage mapping: branch_zones (authenticated writes)
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS branch_zones_write_policy ON public.branch_zones;
CREATE POLICY branch_zones_write_policy ON public.branch_zones
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', public.current_user_org_id())
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.branches b
        WHERE b.id = public.branch_zones.branch_id
          AND b.organization_id = public.current_user_org_id()
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
        FROM public.branches b
        WHERE b.id = branch_id
          AND b.organization_id = public.current_user_org_id()
      )
    )
  );

-------------------------------------------------------------------------------
-- 2) Geography primitives: zones + zone_districts (authenticated writes)
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS zones_org_policy ON public.zones;

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

DROP POLICY IF EXISTS zone_districts_org_policy ON public.zone_districts;

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

SELECT pg_advisory_unlock(hashtext('202601300220_rbac_geography_coverage_write_gates_v1'));
COMMIT;

