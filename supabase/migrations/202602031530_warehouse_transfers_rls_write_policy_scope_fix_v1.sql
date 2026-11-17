-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Warehouse transfers RLS write policy scope fix v1
-- Purpose:
-- - Prevent client/sender scopes from gaining SELECT/WRITE access via generic write capability guards.
-- - Keep handling units + warehouse transfers tenant-only (plus platform override) per foundation contracts.

BEGIN;

-- NOTE:
-- These tables intentionally expose tenant-only operational planning/manifests. Generic write capabilities
-- (e.g., system.write) must not broaden read access for client/sender scopes.

DROP POLICY IF EXISTS handling_units_write_policy ON public.handling_units;
CREATE POLICY handling_units_write_policy ON public.handling_units
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
    )
  );

DROP POLICY IF EXISTS warehouse_transfers_write_policy ON public.warehouse_transfers;
CREATE POLICY warehouse_transfers_write_policy ON public.warehouse_transfers
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
    )
  );

DROP POLICY IF EXISTS warehouse_transfer_items_write_policy ON public.warehouse_transfer_items;
CREATE POLICY warehouse_transfer_items_write_policy ON public.warehouse_transfer_items
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
    )
  );

COMMIT;
