-- Plan: Release deploy compatibility / Step: DB01
-- Migration: Route-stop visible view pre-shape compatibility
-- Purpose:
-- - Prepare route_stops_visible_v1 for the Batch 7 delivery-attempt projection.
-- - Keep migration history append-only while avoiding PostgreSQL view-column
--   rename failures in the following 202604101100 migration.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101059_route_stops_visible_pre_shape_compat_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Rebuild existing route-stop read views into the target column shape.
-------------------------------------------------------------------------------

DROP VIEW IF EXISTS api.route_stops;
DROP VIEW IF EXISTS public.route_stops_visible_v1;

CREATE VIEW public.route_stops_visible_v1
WITH (security_invoker = true) AS
SELECT
  rs.*,
  rr.status AS route_run_status,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.branch_id,
  rr.route_plan_id,
  rr.planned_date,
  rr.planned_start_at AS route_planned_start_at,
  rr.planned_end_at AS route_planned_end_at,
  COALESCE(rr.metadata->'route_assignment', '{}'::jsonb) AS route_assignment,
  NULL::uuid AS shipment_action_id,
  COALESCE(
    NULLIF(btrim(COALESCE(rs.metadata #>> ARRAY['execution', 'outcome'], '')), ''),
    'untouched'
  ) AS route_stop_outcome,
  NULL::text AS delivery_attempt_outcome,
  NULL::text AS delivery_attempt_reason,
  NULL::text AS dispatch_exception_reason,
  NULL::text AS delivery_attempt_ndr_action,
  NULL::integer AS delivery_attempt_count,
  NULL::boolean AS delivery_attempt_eligible,
  NULL::timestamptz AS delivery_attempted_at
FROM public.route_stops rs
JOIN public.route_runs rr
  ON rr.id = rs.route_run_id
WHERE public.route_run_actor_can_read_v1(
  rs.organization_id,
  rs.route_run_id,
  rr.driver_user_id
);

COMMENT ON VIEW public.route_stops_visible_v1 IS
  'Executor-safe route_stop manifest projection pre-shaped for Batch 7 delivery-attempt metadata compatibility.';

REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM anon;
GRANT SELECT ON TABLE public.route_stops_visible_v1 TO authenticated, service_role;

CREATE VIEW api.route_stops
WITH (security_invoker = true) AS
SELECT *
FROM public.route_stops_visible_v1;

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection pre-shaped for Batch 7 delivery-attempt metadata compatibility.';

REVOKE ALL ON api.route_stops FROM PUBLIC;
REVOKE ALL ON api.route_stops FROM anon;
GRANT SELECT ON api.route_stops TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604101059_route_stops_visible_pre_shape_compat_v1'));
COMMIT;
