BEGIN;

-- Restore the browser-safe route run projection after older compatibility
-- rebuilds left api.route_runs on the base table shape in some local/shared
-- histories. Console V2 route reads need top-level assignment and execution
-- manifest metadata, not only the raw route_runs.metadata fallback.
CREATE OR REPLACE VIEW api.route_runs
WITH (security_invoker = true) AS
SELECT
  rr.id,
  rr.organization_id,
  rr.branch_id,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.status,
  rr.planned_date,
  rr.planned_start_at,
  rr.planned_end_at,
  rr.started_at,
  rr.ended_at,
  rr.metadata,
  rr.created_at,
  rr.updated_at,
  rr.idempotency_key,
  rr.idempotency_hash,
  rr.route_plan_id,
  COALESCE(
    public.ui_route_run_assignment_projection_v1(rr.id),
    COALESCE(rr.route_assignment, '{}'::jsonb)
  ) AS route_assignment,
  public.ui_route_run_execution_manifest_v1(rr.id) AS route_execution_manifest
FROM public.route_runs_visible_v1 rr;

COMMENT ON VIEW api.route_runs IS
  'Browser-safe executor-scoped route_run manifest projection with top-level route assignment and execution manifest metadata for Console V2 generic reads.';

REVOKE ALL ON api.route_runs FROM PUBLIC;
REVOKE ALL ON api.route_runs FROM anon;
GRANT SELECT ON api.route_runs TO authenticated, service_role;

COMMIT;
