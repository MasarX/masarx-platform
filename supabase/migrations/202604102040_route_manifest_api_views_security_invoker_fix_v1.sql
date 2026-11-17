-- Migration: route manifest api views security_invoker fix v1
-- Purpose:
--   - Restore security_invoker=true on the browser-safe route manifest api views.
--   - Preserve the existing executor-scoped projections and grants.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102040_route_manifest_api_views_security_invoker_fix_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW api.route_runs
WITH (security_invoker = true) AS
SELECT
  rr.*,
  COALESCE(
    public.route_run_assignment_projection_v1(rr.id),
    COALESCE(rr.metadata->'route_assignment', '{}'::jsonb)
  ) AS route_assignment,
  public.route_run_execution_manifest_build_v1(rr.id) AS route_execution_manifest
FROM public.route_runs rr
WHERE public.route_run_actor_can_read_v1(
  rr.organization_id,
  rr.id,
  rr.driver_user_id
);

COMMENT ON VIEW api.route_runs IS
  'Browser-safe executor-scoped route_run manifest projection built directly from public.route_runs.';

REVOKE ALL ON api.route_runs FROM PUBLIC;
REVOKE ALL ON api.route_runs FROM anon;
GRANT SELECT ON api.route_runs TO authenticated, service_role;

CREATE OR REPLACE VIEW api.route_stops
WITH (security_invoker = true) AS
SELECT *
FROM public.route_stops_visible_v1;

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection built through public.route_stops_visible_v1.';

REVOKE ALL ON api.route_stops FROM PUBLIC;
REVOKE ALL ON api.route_stops FROM anon;
GRANT SELECT ON api.route_stops TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604102040_route_manifest_api_views_security_invoker_fix_v1'));
COMMIT;
