-- Plan: PLAN-202604-b06-route-run-execution-manifest / Step: E01
-- Migration: Route route manifest surfaces through fresh runtime-stable helpers

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101330_route_run_manifest_runtime_stability_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.route_run_assignment_projection_current_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
/* objectives:allow RLS_OFF Justification: SECURITY DEFINER helper re-applies explicit actor visibility checks before building the assignment projection. */
SET row_security = off
AS $function$
  SELECT CASE
    WHEN $1 IS NULL THEN NULL
    ELSE (
      SELECT (
        SELECT jsonb_strip_nulls(
                 jsonb_build_object(
                   'route_run_assignment_id', rra.id,
                   'assignment_status', rra.assignment_status,
                   'assignment_mode', rra.assignment_mode,
                   'assignment_version', rra.assignment_version,
                   'driver_user_id', rra.driver_user_id,
                   'vehicle_id', rra.vehicle_id,
                   'partner', rra.partner,
                   'assigned_by_user_id', rra.assigned_by_user_id,
                   'assigned_at', rra.assigned_at,
                   'notes', rra.notes,
                   'metadata', NULLIF(rra.metadata, '{}'::jsonb),
                   'responded_by_user_id', rra.responded_by_user_id,
                   'acknowledged_at', rra.acknowledged_at,
                   'accepted_at', rra.accepted_at,
                   'refused_at', rra.refused_at,
                   'refusal_reason', rra.refusal_reason,
                   'response_notes', rra.response_notes,
                   'response_metadata', NULLIF(rra.response_metadata, '{}'::jsonb)
                 )
               )
          FROM public.route_run_assignments rra
         WHERE rra.route_run_id = rr.id
         ORDER BY rra.created_at DESC, rra.id DESC
         LIMIT 1
      )
        FROM public.route_runs rr
       WHERE rr.id = $1
         AND public.route_run_actor_can_read_v1(
           rr.organization_id,
           rr.id,
           rr.driver_user_id
         )
       LIMIT 1
    )
  END
$function$;

COMMENT ON FUNCTION public.route_run_assignment_projection_current_v1(UUID)
  IS 'Runtime-stable canonical JSON projection of the current route_run assignment state from route_run_assignments.';

REVOKE ALL ON FUNCTION public.route_run_assignment_projection_current_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_assignment_projection_current_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_run_assignment_projection_current_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.route_run_execution_manifest_current_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
/* objectives:allow RLS_OFF Justification: SECURITY DEFINER manifest builder composes vetted helper reads after explicit actor visibility validation. */
SET row_security = off
AS $function$
DECLARE
  v_route_run public.route_runs%ROWTYPE;
  v_assignment JSONB := '{}'::jsonb;
  v_route_plan_pack JSONB := NULL;
  v_stops JSONB := '[]'::jsonb;
  v_stop_count INT := 0;
  v_completed_stop_count INT := 0;
  v_open_stop_task_count INT := 0;
  v_manifest_core JSONB := '{}'::jsonb;
BEGIN
  IF p_route_run_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = p_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT public.route_run_actor_can_read_v1(
    v_route_run.organization_id,
    v_route_run.id,
    v_route_run.driver_user_id
  ) THEN
    RETURN NULL;
  END IF;

  v_assignment := COALESCE(public.route_run_assignment_projection_current_v1(v_route_run.id), '{}'::jsonb);

  IF v_route_run.route_plan_id IS NOT NULL THEN
    v_route_plan_pack := public.route_plan_execution_pack_v1(v_route_run.route_plan_id);
  END IF;

  SELECT
    COALESCE(jsonb_agg(item.stop_payload ORDER BY item.sequence_order, item.route_stop_created_at, item.route_stop_id), '[]'::jsonb),
    COUNT(*)::INT,
    COUNT(*) FILTER (
      WHERE item.shipment_action IS NOT NULL
         OR item.task_status = 'completed'
         OR v_route_run.status = 'completed'
    )::INT,
    COUNT(*) FILTER (
      WHERE item.task_status IS NULL OR item.task_status NOT IN ('completed', 'canceled')
    )::INT
    INTO v_stops,
         v_stop_count,
         v_completed_stop_count,
         v_open_stop_task_count
    FROM (
      SELECT
        rs.id AS route_stop_id,
        rs.sequence_order,
        rs.created_at AS route_stop_created_at,
        NULLIF(btrim(COALESCE(rs.metadata->>'shipment_action', '')), '') AS shipment_action,
        COALESCE(t.status, '') AS task_status,
        jsonb_strip_nulls(
          jsonb_build_object(
            'route_stop_id', rs.id,
            'sequence_order', rs.sequence_order,
            'stop_kind', rs.stop_kind,
            'planned_window_start_at', rs.planned_window_start_at,
            'planned_window_end_at', rs.planned_window_end_at,
            'shipment_id', rs.shipment_id,
            'client_id', rs.client_id,
            'shipment_tracking_number', s.tracking_number,
            'shipment_status', s.status,
            'route_stop_metadata', NULLIF(rs.metadata, '{}'::jsonb),
            'task',
              CASE
                WHEN t.id IS NULL THEN NULL
                ELSE jsonb_strip_nulls(
                  jsonb_build_object(
                    'task_id', t.id,
                    'status', t.status,
                    'assigned_to', t.assigned_to,
                    'workflow_run_id', t.workflow_run_id
                  )
                )
              END
          )
        ) AS stop_payload
      FROM public.route_stops rs
      JOIN public.shipments s
        ON s.id = rs.shipment_id
       AND s.client_id = rs.client_id
      LEFT JOIN LATERAL (
        SELECT
          t.id,
          t.status,
          t.assigned_to,
          t.workflow_run_id
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.resource_type = 'route_stop'
         AND t.resource_id = rs.id
         AND tt.organization_id = v_route_run.organization_id
         AND tt.key = 'route_stop_execute'
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1
      ) t ON TRUE
      WHERE rs.route_run_id = v_route_run.id
    ) AS item;

  v_manifest_core := jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_id', v_route_run.id,
      'organization_id', v_route_run.organization_id,
      'branch_id', v_route_run.branch_id,
      'route_plan_id', v_route_run.route_plan_id,
      'planned_date', v_route_run.planned_date,
      'route_run_status', v_route_run.status,
      'started_at', v_route_run.started_at,
      'ended_at', v_route_run.ended_at,
      'driver_user_id', v_route_run.driver_user_id,
      'vehicle_id', v_route_run.vehicle_id,
      'route_plan_execution_pack_hash', NULLIF(COALESCE(v_route_run.metadata->>'route_plan_execution_pack_hash', ''), ''),
      'route_assignment', NULLIF(v_assignment, '{}'::jsonb),
      'published_execution_pack_hash', NULLIF(COALESCE(v_route_plan_pack->>'execution_pack_hash', ''), ''),
      'stop_count', v_stop_count,
      'completed_stop_count', v_completed_stop_count,
      'open_stop_task_count', v_open_stop_task_count,
      'stops', v_stops,
      'source', jsonb_strip_nulls(
        jsonb_build_object(
          'resource', 'route_runs',
          'route_plan_id', v_route_run.route_plan_id,
          'route_plan_execution_pack_hash', NULLIF(COALESCE(v_route_run.metadata->>'route_plan_execution_pack_hash', ''), ''),
          'route_run_assignment_id', NULLIF(v_assignment->>'route_run_assignment_id', '')
        )
      )
    )
  );

  RETURN jsonb_set(
    v_manifest_core,
    '{manifest_hash}',
    to_jsonb(public.route_plan_execution_pack_hash_v1(v_manifest_core)),
    TRUE
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_execution_manifest_current_v1(UUID)
  IS 'Runtime-stable canonical route_run execution manifest builder with stop list + current assignment overlay for executor surfaces.';

REVOKE ALL ON FUNCTION public.route_run_execution_manifest_current_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_execution_manifest_current_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_run_execution_manifest_current_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.route_run_execution_manifest_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.route_run_execution_manifest_current_v1($1);
$function$;

CREATE OR REPLACE FUNCTION public.ui_route_run_execution_manifest_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_route_run public.route_runs%ROWTYPE;
BEGIN
  SELECT *
    INTO v_route_run
    FROM public.ui_route_run_visible_v1(p_route_run_id, 'read');

  RETURN public.route_run_execution_manifest_current_v1(v_route_run.id);
END;
$function$;

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
    public.route_run_assignment_projection_current_v1(rr.id),
    COALESCE(rr.route_assignment, '{}'::jsonb)
  ) AS route_assignment,
  public.route_run_execution_manifest_current_v1(rr.id) AS route_execution_manifest
FROM public.route_runs_visible_v1 rr;

SELECT pg_advisory_unlock(hashtext('202604101330_route_run_manifest_runtime_stability_v1'));

COMMIT;
