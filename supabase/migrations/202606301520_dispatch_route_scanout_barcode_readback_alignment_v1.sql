-- Migration: Dispatch route scanout barcode readback alignment v1
-- Purpose:
--   - Keep stop-level route-load scan readback aligned with the canonical
--     route-run scan-out reconciliation gate.
--   - Count route-level barcode-only load scans against the expected shipment
--     tracking number so operators do not see a ready route with missing
--     per-stop readback.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606301520_dispatch_route_scanout_barcode_readback_alignment_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.route_stop_load_scan_readback_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_route_run_id UUID,
  p_route_stop_id UUID,
  p_shipment_id UUID
)
RETURNS TABLE(load_scan_count INT, last_load_scanned_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
/* objectives:allow RLS_OFF Justification: SECURITY DEFINER readback helper first validates route-run actor visibility, then resolves canonical shipment tracking lineage for route-level barcode scans. */
SET row_security = off
AS $function$
  WITH route_run_scope AS (
    SELECT rr.id
    FROM public.route_runs rr
    WHERE rr.id = p_route_run_id
      AND rr.organization_id = p_organization_id
      AND public.route_run_actor_can_read_v1(rr.organization_id, rr.id, rr.driver_user_id)
    LIMIT 1
  ),
  expected_shipment AS (
    SELECT
      s.id,
      upper(NULLIF(btrim(COALESCE(s.tracking_number, '')), '')) AS tracking_upper
    FROM public.shipments s
    JOIN route_run_scope scope
      ON TRUE
    WHERE s.id = p_shipment_id
      AND s.client_id = p_client_id
      AND s.organization_id = p_organization_id
    LIMIT 1
  )
  SELECT
    COUNT(*)::INT AS load_scan_count,
    MAX(se.captured_at) AS last_load_scanned_at
  FROM public.scan_events se
  JOIN route_run_scope scope
    ON TRUE
  LEFT JOIN expected_shipment expected
    ON TRUE
  WHERE se.organization_id = p_organization_id
    AND se.route_run_id = p_route_run_id
    AND lower(COALESCE(se.scan_type, '')) = 'load'
    AND (
      se.route_stop_id = p_route_stop_id
      OR (
        se.route_stop_id IS NULL
        AND p_shipment_id IS NOT NULL
        AND se.shipment_id = p_shipment_id
      )
      OR (
        se.route_stop_id IS NULL
        AND se.shipment_id IS NULL
        AND expected.id IS NOT NULL
        AND expected.tracking_upper IS NOT NULL
        AND upper(NULLIF(btrim(COALESCE(se.barcode, '')), '')) = expected.tracking_upper
      )
    );
$function$;

COMMENT ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID)
  IS 'Route-run-scoped per-stop load scan readback helper aligned with route_run_scan_out_reconciliation_v1 route-stop, shipment, and barcode matching.';

REVOKE ALL ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) TO authenticated, service_role;

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
      LEFT JOIN LATERAL public.route_stop_load_scan_readback_v1(
        v_route_run.organization_id,
        rs.client_id,
        v_route_run.id,
        rs.id,
        rs.shipment_id
      ) AS load_scan ON TRUE
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
  IS 'Runtime-stable canonical route_run execution manifest builder with current assignment overlay, route-load scan-out reconciliation, barcode-aligned stop readback, and departure audit state.';

CREATE OR REPLACE VIEW public.route_stops_visible_v1
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
  COALESCE(
    public.route_run_assignment_projection_v1(rr.id),
    COALESCE(rr.metadata->'route_assignment', '{}'::jsonb)
  ) AS route_assignment,
  shipment_snapshot.cod_amount,
  shipment_snapshot.cod_currency,
  shipment_snapshot.payment AS payment,
  CASE
    WHEN COALESCE(shipment_snapshot.payment->>'expected_amount', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (shipment_snapshot.payment->>'expected_amount')::numeric
    ELSE NULL
  END AS expected_amount,
  CASE lower(COALESCE(shipment_snapshot.payment->>'collection_required', ''))
    WHEN 'true' THEN TRUE
    WHEN 'false' THEN FALSE
    ELSE NULL
  END AS collection_required,
  COALESCE(shipment_snapshot.payment->'allowed_methods', '[]'::jsonb) AS allowed_methods,
  NULLIF(btrim(COALESCE(shipment_snapshot.payment->>'payment_mode_label', '')), '') AS payment_mode_label,
  latest_action.id AS shipment_action_id,
  COALESCE(
    NULLIF(btrim(COALESCE(rs.metadata #>> ARRAY['execution', 'outcome'], '')), ''),
    latest_action.route_stop_outcome,
    CASE
      WHEN latest_action.id IS NOT NULL AND latest_action.delivery_attempt_outcome = 'delivered' THEN 'completed'
      WHEN latest_action.id IS NOT NULL THEN 'attempted'
      WHEN EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(rr.metadata #> '{route_closeout,remaining_stop_ids}') = 'array'
                     THEN rr.metadata #> '{route_closeout,remaining_stop_ids}'
                   ELSE '[]'::jsonb
                 END
               ) AS remaining(value)
         WHERE remaining.value = rs.id::text
      ) THEN 'skipped'
      ELSE 'untouched'
    END
  ) AS route_stop_outcome,
  latest_action.delivery_attempt_outcome,
  latest_action.delivery_attempt_reason,
  latest_action.dispatch_exception_reason,
  latest_action.delivery_attempt_ndr_action,
  latest_action.delivery_attempt_count,
  latest_action.delivery_attempt_eligible,
  latest_action.delivery_attempted_at,
  COALESCE(load_scan.load_scan_count, 0) AS load_scan_count,
  load_scan.last_load_scanned_at,
  CASE
    WHEN rs.shipment_id IS NULL THEN NULL
    WHEN COALESCE(load_scan.load_scan_count, 0) > 0 THEN 'scanned'
    ELSE 'missing'
  END AS load_scan_status
FROM public.route_stops rs
JOIN public.route_runs rr
  ON rr.id = rs.route_run_id
LEFT JOIN LATERAL public.route_stop_shipment_payment_snapshot_v1(rs.id) AS shipment_snapshot
  ON TRUE
LEFT JOIN LATERAL (
  SELECT
    sa.id,
    sa.route_stop_outcome,
    sa.delivery_attempt_outcome,
    sa.delivery_attempt_reason,
    sa.dispatch_exception_reason,
    sa.delivery_attempt_ndr_action,
    sa.delivery_attempt_count,
    sa.delivery_attempt_eligible,
    sa.delivery_attempted_at,
    sa.canonical_status
  FROM public.shipment_actions sa
  WHERE sa.organization_id = rs.organization_id
    AND sa.client_id = rs.client_id
    AND sa.shipment_id = rs.shipment_id
    AND sa.action_data->>'route_stop_id' = rs.id::text
  ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
  LIMIT 1
) AS latest_action
  ON TRUE
LEFT JOIN LATERAL public.route_stop_load_scan_readback_v1(
  rs.organization_id,
  rs.client_id,
  rs.route_run_id,
  rs.id,
  rs.shipment_id
) AS load_scan
  ON TRUE
WHERE public.route_run_actor_can_read_v1(
  rs.organization_id,
  rs.route_run_id,
  rr.driver_user_id
);

COMMENT ON VIEW public.route_stops_visible_v1 IS
  'Executor-safe route_stop manifest projection scoped to the visible route inventory, including delivery-attempt outcomes, COD payment terms, and barcode-aligned per-stop route-load scan-out state.';

REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM anon;
GRANT SELECT ON TABLE public.route_stops_visible_v1 TO authenticated, service_role;

CREATE OR REPLACE VIEW api.route_stops
WITH (security_invoker = true) AS
SELECT *
FROM public.route_stops_visible_v1;

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection with delivery-attempt, COD payment, and barcode-aligned route-load scan-out metadata.';

REVOKE ALL ON TABLE api.route_stops FROM PUBLIC;
REVOKE ALL ON TABLE api.route_stops FROM anon;
GRANT SELECT ON TABLE api.route_stops TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606301520_dispatch_route_scanout_barcode_readback_alignment_v1'));

COMMIT;
