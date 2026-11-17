-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC gates for fleet write paths v1
-- Date: 2026-01-30
--
-- Why:
--   - Fleet (vehicles, assignments, maintenance) is an enterprise-critical control surface.
--   - Prior baseline allowed any tenant-scoped user to mutate fleet tables via `user_can_write()`.
--   - Enforce least-privilege by requiring RBAC permission `fleet.write` for authenticated writes.
--
-- Notes:
--   - Reads remain tenant-scoped (no breaking change for existing read paths).
--   - service_role policies remain authoritative for automation/workflows.
--   - Uses stable predicate `user_has_permission_v1` (row-driven; no hardcoded app roles).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300330_rbac_fleet_write_gates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- Fleet tables: authenticated writes require fleet.write
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS vehicle_types_write_policy ON public.vehicle_types;
CREATE POLICY vehicle_types_write_policy ON public.vehicle_types
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicles_write_policy ON public.vehicles;
CREATE POLICY vehicles_write_policy ON public.vehicles
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicle_assignments_write_policy ON public.vehicle_assignments;
CREATE POLICY vehicle_assignments_write_policy ON public.vehicle_assignments
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicle_maintenance_windows_write_policy ON public.vehicle_maintenance_windows;
CREATE POLICY vehicle_maintenance_windows_write_policy ON public.vehicle_maintenance_windows
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

SELECT pg_advisory_unlock(hashtext('202601300330_rbac_fleet_write_gates_v1'));
COMMIT;

