-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Route runs RLS write policy scope fix v1
-- Purpose:
-- - Prevent client/sender scopes from gaining SELECT/WRITE access via generic write capability guards.
-- - Keep route plan access tenant-only (plus platform override) per route_runs/route_stops foundation contract.

BEGIN;

-- IMPORTANT:
-- `user_can_write()` is a generic capability guard (e.g., system.write). It must not implicitly broaden
-- route planning visibility beyond tenant/platform scopes.

DROP POLICY IF EXISTS route_runs_write_policy ON public.route_runs;
CREATE POLICY route_runs_write_policy ON public.route_runs
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

DROP POLICY IF EXISTS route_stops_write_policy ON public.route_stops;
CREATE POLICY route_stops_write_policy ON public.route_stops
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
