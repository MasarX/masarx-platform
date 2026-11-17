-- Plan: PLAN-202604-b06-route-run-execution-manifest / Step: E04
-- Migration: route_run_select_policy_manifest_visibility_v1
-- Purpose:
--   - Align public.route_runs/public.route_stops authenticated reads with the
--     canonical route manifest visibility helper so generic ui_list_resource_v1
--     listings and direct api.route_* reads return the same executor-scoped set.
--   - Preserve tenant-wide inventory visibility for operators through the
--     routes.write branch inside route_run_actor_can_read_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604092110_route_run_select_policy_manifest_visibility_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP POLICY IF EXISTS route_runs_select_policy ON public.route_runs;
CREATE POLICY route_runs_select_policy ON public.route_runs
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR public.route_run_actor_can_read_v1(organization_id, id, driver_user_id)
  );

DROP POLICY IF EXISTS route_stops_select_policy ON public.route_stops;
CREATE POLICY route_stops_select_policy ON public.route_stops
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR public.route_run_actor_can_read_v1(organization_id, route_run_id, NULL)
  );

COMMIT;
