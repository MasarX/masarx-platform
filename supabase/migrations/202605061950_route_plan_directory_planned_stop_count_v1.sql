-- Migration: Route-plan directory planned stop count v1
--
-- Console V2 route planning creates route_plan inputs.stops before materializing
-- route_runs. The directory projection must show those planned stops so operators
-- can solve/freeze/publish/apply from a useful plan instead of seeing "0 stops"
-- until dispatch materialization.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605061950_route_plan_directory_planned_stop_count_v1'));

DROP VIEW IF EXISTS public.v_route_plan_directory;

CREATE VIEW public.v_route_plan_directory AS
WITH run_rollup AS (
  SELECT
    route_plan_id,
    COUNT(*)::INT AS run_count
  FROM public.route_runs
  WHERE route_plan_id IS NOT NULL
  GROUP BY route_plan_id
),
stop_rollup AS (
  SELECT
    rr.route_plan_id,
    COUNT(rs.id)::INT AS stop_count
  FROM public.route_runs rr
  LEFT JOIN public.route_stops rs ON rs.route_run_id = rr.id
  WHERE rr.route_plan_id IS NOT NULL
  GROUP BY rr.route_plan_id
),
planned_stop_rollup AS (
  SELECT
    rp.id AS route_plan_id,
    COALESCE(
      CASE
        WHEN jsonb_typeof(COALESCE(rp.solution->'stops', 'null'::jsonb)) = 'array'
          THEN jsonb_array_length(rp.solution->'stops')
        ELSE NULL
      END,
      CASE
        WHEN jsonb_typeof(COALESCE(rp.inputs->'stops', 'null'::jsonb)) = 'array'
          THEN jsonb_array_length(rp.inputs->'stops')
        ELSE NULL
      END,
      0
    )::INT AS planned_stop_count
  FROM public.route_plans rp
),
notified_rollup AS (
  SELECT
    route_plan_id,
    COUNT(DISTINCT actor_user_id)::INT AS drivers_notified_count
  FROM public.route_plan_events
  WHERE event_type = 'driver_notified'
    AND actor_user_id IS NOT NULL
  GROUP BY route_plan_id
)
SELECT
  rp.id,
  rp.organization_id,
  rp.branch_id,
  rp.planned_date,
  rp.status,
  rp.status_reason,
  rp.requested_by_user_id,
  rp.requested_at,
  rp.solved_at,
  rp.applied_at,
  rp.idempotency_key,
  rp.version,
  rp.metadata,
  rp.created_at,
  rp.updated_at,
  ('PLN-' || upper(substr(replace(rp.id::text, '-', ''), 1, 6))) AS plan_display_id,
  b.name AS branch_label,
  b.code AS branch_code,
  COALESCE(
    rp.metadata->>'wave_label',
    rp.inputs->>'wave_label'
  ) AS wave_label,
  COALESCE(
    rp.metadata->>'wave',
    rp.inputs->>'wave',
    rp.metadata->>'wave_id',
    rp.inputs->>'wave_id'
  ) AS wave_key,
  COALESCE(rrl.run_count, 0) AS run_count,
  GREATEST(
    COALESCE(srl.stop_count, 0),
    COALESCE(psr.planned_stop_count, 0)
  ) AS stop_count,
  COALESCE(nrl.drivers_notified_count, 0) AS drivers_notified_count,
  (rp.applied_at IS NOT NULL) AS is_applied
FROM public.route_plans rp
LEFT JOIN public.branches b ON b.id = rp.branch_id
LEFT JOIN run_rollup rrl ON rrl.route_plan_id = rp.id
LEFT JOIN stop_rollup srl ON srl.route_plan_id = rp.id
LEFT JOIN planned_stop_rollup psr ON psr.route_plan_id = rp.id
LEFT JOIN notified_rollup nrl ON nrl.route_plan_id = rp.id;

ALTER VIEW public.v_route_plan_directory SET (security_invoker = true);

COMMENT ON VIEW public.v_route_plan_directory IS
  'FE-friendly projection of route_plans with branch label/code, wave label/key, run_count, planned-or-materialized stop_count, drivers_notified_count, and is_applied. stop_count uses route_runs/route_stops when materialized and falls back to route_plans.solution.stops or route_plans.inputs.stops before apply.';

REVOKE ALL ON public.v_route_plan_directory FROM PUBLIC;
REVOKE ALL ON public.v_route_plan_directory FROM anon;
REVOKE ALL ON public.v_route_plan_directory FROM authenticated;
GRANT SELECT ON public.v_route_plan_directory TO authenticated;
GRANT SELECT ON public.v_route_plan_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605061950_route_plan_directory_planned_stop_count_v1'));

COMMIT;
