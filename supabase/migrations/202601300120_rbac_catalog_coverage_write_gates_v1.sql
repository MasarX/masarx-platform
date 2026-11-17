-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC gates for catalog + coverage write paths v1
-- Date: 2026-01-30
--
-- Why:
--   - Service catalog and coverage/capacity calendars are enterprise-critical "agreement-adjacent" controls.
--   - Prior baseline allowed any tenant-scoped user to write these tables via `user_can_write()`.
--   - Enforce least-privilege by requiring RBAC permission `agreements.write` for authenticated writes.
--
-- Notes:
--   - Reads remain org-scoped (no breaking change for existing read paths).
--   - service_role policies remain authoritative for automation/workflows.
--   - Uses stable predicate `user_has_permission_v1` (row-driven; no hardcoded app roles).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300120_rbac_catalog_coverage_write_gates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Service catalog: service_levels + service_offerings (authenticated writes)
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS service_levels_write_policy ON public.service_levels;
CREATE POLICY service_levels_write_policy ON public.service_levels
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

DROP POLICY IF EXISTS service_offerings_write_policy ON public.service_offerings;
CREATE POLICY service_offerings_write_policy ON public.service_offerings
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
        WHERE b.id = branch_id
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
-- 2) Coverage/capacity calendars (authenticated writes)
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS branch_coverage_windows_write_policy ON public.branch_coverage_windows;
CREATE POLICY branch_coverage_windows_write_policy ON public.branch_coverage_windows
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
        WHERE b.id = branch_id
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

DROP POLICY IF EXISTS branch_capacity_windows_write_policy ON public.branch_capacity_windows;
CREATE POLICY branch_capacity_windows_write_policy ON public.branch_capacity_windows
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
        WHERE b.id = branch_id
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

DROP POLICY IF EXISTS calendar_events_write_policy ON public.calendar_events;
CREATE POLICY calendar_events_write_policy ON public.calendar_events
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

DROP POLICY IF EXISTS branch_memberships_write_policy ON public.branch_memberships;
CREATE POLICY branch_memberships_write_policy ON public.branch_memberships
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
        WHERE b.id = branch_id
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

SELECT pg_advisory_unlock(hashtext('202601300120_rbac_catalog_coverage_write_gates_v1'));
COMMIT;

