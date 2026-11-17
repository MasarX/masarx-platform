-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC gates for branches write paths v1
-- Date: 2026-01-30
--
-- Why:
--   - Branches are enterprise-critical operational units that affect coverage, pricing, routing, and SLAs.
--   - Prior baseline allowed any tenant-scoped user to mutate branches via `user_can_write()`.
--   - Enforce least-privilege by requiring RBAC permission `agreements.write` for authenticated writes.
--
-- Notes:
--   - Reads remain tenant-scoped (no breaking change for existing read paths).
--   - service_role policies remain authoritative for automation/workflows.
--   - Uses stable predicate `user_has_permission_v1` (row-driven; no hardcoded app roles).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300340_rbac_branches_write_gates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- Branches: authenticated writes require agreements.write
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS branches_write_policy ON public.branches;
CREATE POLICY branches_write_policy ON public.branches
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

SELECT pg_advisory_unlock(hashtext('202601300340_rbac_branches_write_gates_v1'));
COMMIT;

