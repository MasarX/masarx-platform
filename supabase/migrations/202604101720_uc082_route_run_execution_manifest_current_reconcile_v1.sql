-- Migration: Route run execution manifest current reconcile v1
-- Purpose:
--   - Keep the runtime-stable manifest wrapper aligned with the scan-out and
--     route departure contract introduced by UC082.
--   - Preserve executor visibility checks while exposing scan_out on
--     ui_route_run_execution_manifest_v1 and api.route_runs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101720_uc082_route_run_execution_manifest_current_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_scan_out JSONB := '{}'::jsonb;
  v_route_departure JSONB := NULL;
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
  v_scan_out := COALESCE(public.route_run_scan_out_reconciliation_v1(v_route_run.id), '{}'::jsonb);
  v_route_departure := NULLIF(COALESCE(v_route_run.metadata->'route_departure', '{}'::jsonb), '{}'::jsonb);

  IF v_route_run.route_plan_id IS NOT NULL THEN
    v_route_plan_pack := public.route_plan_execution_pack_v1(v_route_run.route_plan_id);
  END IF;

  SELECT
    COALESCE(
      jsonb_agg(
        item.stop_payload
        ORDER BY item.sequence_order, item.route_stop_created_at, item.route_stop_id
      ),
      '[]'::jsonb
    ),
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
            'scan_out', jsonb_strip_nulls(
              jsonb_build_object(
                'load_scan_count', COALESCE(load_scan.load_scan_count, 0),
                'last_load_scanned_at', load_scan.last_load_scanned_at,
                'status',
                  CASE
                    WHEN COALESCE(load_scan.load_scan_count, 0) > 0 THEN 'scanned'
                    ELSE 'missing'
                  END
              )
            ),
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
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::INT AS load_scan_count,
          MAX(se.captured_at) AS last_load_scanned_at
        FROM public.scan_events se
        WHERE se.organization_id = v_route_run.organization_id
          AND se.route_run_id = v_route_run.id
          AND lower(COALESCE(se.scan_type, '')) = 'load'
          AND (
            se.route_stop_id = rs.id
            OR (
              se.route_stop_id IS NULL
              AND rs.shipment_id IS NOT NULL
              AND se.shipment_id = rs.shipment_id
            )
          )
      ) load_scan ON TRUE
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
      'scan_out', NULLIF(v_scan_out, '{}'::jsonb),
      'route_departure', v_route_departure,
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
  IS 'Runtime-stable canonical route_run execution manifest builder with current assignment overlay, route-load scan-out reconciliation, and departure audit state.';

SELECT pg_advisory_unlock(hashtext('202604101720_uc082_route_run_execution_manifest_current_reconcile_v1'));

COMMIT;
