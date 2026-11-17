-- Migration: UC082 route run scan-out departure gate v1
-- Purpose:
--   - Reconcile route-load scans against the canonical route_run stop plan before departure.
--   - Expose route departure readiness on the route manifest/read-model path.
--   - Confirm departure once, audit it on the route_run metadata trail, and fail closed when scans do not match.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101500_uc082_route_run_scan_out_departure_gate_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout TO '30s';

-------------------------------------------------------------------------------
-- 1) Canonical route-load scan reconciliation helper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_run_scan_out_reconciliation_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_route_run RECORD;
  v_expected RECORD;
  v_scan RECORD;
  v_stop_counts JSONB := '{}'::jsonb;
  v_stop_last_scan JSONB := '{}'::jsonb;
  v_expected_by_shipment JSONB := '{}'::jsonb;
  v_expected_by_barcode JSONB := '{}'::jsonb;
  v_expected_shipment_ids JSONB := '{}'::jsonb;
  v_expected_stop_sequence JSONB := '{}'::jsonb;
  v_expected_stop_count INT := 0;
  v_scanned_stop_count INT := 0;
  v_matched_scan_count INT := 0;
  v_missing_stop_count INT := 0;
  v_duplicate_scan_count INT := 0;
  v_unexpected_scan_count INT := 0;
  v_last_load_scanned_at TIMESTAMPTZ := NULL;
  v_missing_route_stop_ids JSONB := '[]'::jsonb;
  v_missing_shipment_ids JSONB := '[]'::jsonb;
  v_duplicate_route_stop_ids JSONB := '[]'::jsonb;
  v_unexpected_scan_event_ids JSONB := '[]'::jsonb;
  v_unexpected_barcodes JSONB := '[]'::jsonb;
  v_matched_route_stop_id UUID := NULL;
  v_count INT := 0;
  v_existing_last TEXT := NULL;
  v_existing_last_ts TIMESTAMPTZ := NULL;
BEGIN
  IF p_route_run_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT rr.id, rr.organization_id
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = p_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RETURN NULL;
  END IF;

  FOR v_expected IN
    SELECT
      rs.id AS route_stop_id,
      rs.shipment_id,
      rs.sequence_order,
      upper(NULLIF(btrim(COALESCE(s.tracking_number, '')), '')) AS tracking_upper
    FROM public.route_stops rs
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    WHERE rs.route_run_id = v_route_run.id
      AND rs.shipment_id IS NOT NULL
    ORDER BY rs.sequence_order, rs.id
  LOOP
    v_expected_stop_count := v_expected_stop_count + 1;
    v_expected_stop_sequence := jsonb_set(
      v_expected_stop_sequence,
      ARRAY[v_expected.route_stop_id::text],
      to_jsonb(v_expected.sequence_order),
      TRUE
    );
    v_expected_shipment_ids := jsonb_set(
      v_expected_shipment_ids,
      ARRAY[v_expected.route_stop_id::text],
      to_jsonb(v_expected.shipment_id),
      TRUE
    );

    IF v_expected.shipment_id IS NOT NULL THEN
      v_expected_by_shipment := jsonb_set(
        v_expected_by_shipment,
        ARRAY[v_expected.shipment_id::text],
        to_jsonb(v_expected.route_stop_id),
        TRUE
      );
    END IF;

    IF v_expected.tracking_upper IS NOT NULL THEN
      v_expected_by_barcode := jsonb_set(
        v_expected_by_barcode,
        ARRAY[v_expected.tracking_upper],
        to_jsonb(v_expected.route_stop_id),
        TRUE
      );
    END IF;
  END LOOP;

  FOR v_scan IN
    SELECT
      se.id AS scan_event_id,
      se.route_stop_id,
      se.shipment_id,
      upper(NULLIF(btrim(COALESCE(se.barcode, '')), '')) AS barcode_upper,
      se.captured_at
    FROM public.scan_events se
    WHERE se.organization_id = v_route_run.organization_id
      AND se.route_run_id = v_route_run.id
      AND lower(COALESCE(se.scan_type, '')) = 'load'
    ORDER BY se.captured_at DESC, se.id DESC
  LOOP
    v_matched_route_stop_id := NULL;

    IF v_scan.route_stop_id IS NOT NULL
       AND v_expected_stop_sequence ? v_scan.route_stop_id::text THEN
      v_matched_route_stop_id := v_scan.route_stop_id;
    ELSIF v_scan.shipment_id IS NOT NULL
       AND v_expected_by_shipment ? v_scan.shipment_id::text THEN
      v_matched_route_stop_id := (v_expected_by_shipment ->> v_scan.shipment_id::text)::uuid;
    ELSIF v_scan.barcode_upper IS NOT NULL
       AND v_expected_by_barcode ? v_scan.barcode_upper THEN
      v_matched_route_stop_id := (v_expected_by_barcode ->> v_scan.barcode_upper)::uuid;
    END IF;

    IF v_matched_route_stop_id IS NULL THEN
      v_unexpected_scan_count := v_unexpected_scan_count + 1;
      v_unexpected_scan_event_ids :=
        v_unexpected_scan_event_ids || jsonb_build_array(v_scan.scan_event_id);
      IF v_scan.barcode_upper IS NOT NULL THEN
        v_unexpected_barcodes :=
          v_unexpected_barcodes || jsonb_build_array(v_scan.barcode_upper);
      END IF;
      CONTINUE;
    END IF;

    v_matched_scan_count := v_matched_scan_count + 1;
    v_count := COALESCE((v_stop_counts ->> v_matched_route_stop_id::text)::INT, 0) + 1;
    v_stop_counts := jsonb_set(
      v_stop_counts,
      ARRAY[v_matched_route_stop_id::text],
      to_jsonb(v_count),
      TRUE
    );

    v_existing_last := NULLIF(v_stop_last_scan ->> v_matched_route_stop_id::text, '');
    v_existing_last_ts :=
      CASE
        WHEN v_existing_last IS NULL THEN NULL
        ELSE v_existing_last::timestamptz
      END;

    IF v_existing_last_ts IS NULL OR v_scan.captured_at > v_existing_last_ts THEN
      v_stop_last_scan := jsonb_set(
        v_stop_last_scan,
        ARRAY[v_matched_route_stop_id::text],
        to_jsonb(v_scan.captured_at),
        TRUE
      );
    END IF;

    IF v_last_load_scanned_at IS NULL OR v_scan.captured_at > v_last_load_scanned_at THEN
      v_last_load_scanned_at := v_scan.captured_at;
    END IF;
  END LOOP;

  FOR v_expected IN
    SELECT
      rs.id AS route_stop_id,
      rs.shipment_id,
      rs.sequence_order
    FROM public.route_stops rs
    WHERE rs.route_run_id = v_route_run.id
      AND rs.shipment_id IS NOT NULL
    ORDER BY rs.sequence_order, rs.id
  LOOP
    v_count := COALESCE((v_stop_counts ->> v_expected.route_stop_id::text)::INT, 0);

    IF v_count > 0 THEN
      v_scanned_stop_count := v_scanned_stop_count + 1;
    ELSE
      v_missing_stop_count := v_missing_stop_count + 1;
      v_missing_route_stop_ids :=
        v_missing_route_stop_ids || jsonb_build_array(v_expected.route_stop_id);
      v_missing_shipment_ids :=
        v_missing_shipment_ids || jsonb_build_array(v_expected.shipment_id);
    END IF;

    IF v_count > 1 THEN
      v_duplicate_scan_count := v_duplicate_scan_count + (v_count - 1);
      v_duplicate_route_stop_ids :=
        v_duplicate_route_stop_ids || jsonb_build_array(v_expected.route_stop_id);
    END IF;
  END LOOP;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_id', v_route_run.id,
      'expected_stop_count', v_expected_stop_count,
      'expected_shipment_count', v_expected_stop_count,
      'scanned_stop_count', v_scanned_stop_count,
      'scanned_shipment_count', v_scanned_stop_count,
      'matched_scan_count', v_matched_scan_count,
      'missing_stop_count', v_missing_stop_count,
      'duplicate_scan_count', v_duplicate_scan_count,
      'unexpected_scan_count', v_unexpected_scan_count,
      'last_load_scanned_at', v_last_load_scanned_at,
      'missing_route_stop_ids', NULLIF(v_missing_route_stop_ids, '[]'::jsonb),
      'missing_shipment_ids', NULLIF(v_missing_shipment_ids, '[]'::jsonb),
      'duplicate_route_stop_ids', NULLIF(v_duplicate_route_stop_ids, '[]'::jsonb),
      'unexpected_scan_event_ids', NULLIF(v_unexpected_scan_event_ids, '[]'::jsonb),
      'unexpected_barcodes', NULLIF(v_unexpected_barcodes, '[]'::jsonb),
      'ready_for_departure',
        CASE
          WHEN v_expected_stop_count > 0
           AND v_missing_stop_count = 0
           AND v_unexpected_scan_count = 0
          THEN TRUE
          ELSE FALSE
        END
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID)
  IS 'Canonical route-load scan reconciliation for a route run. Compares load scan_events against the planned route_stop shipment set and reports missing, duplicate, and unexpected scans.';

REVOKE ALL ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Route execution manifest carries scan-out readiness + departure audit
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_run_execution_manifest_build_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
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

  v_assignment := COALESCE(public.route_run_assignment_projection_v1(v_route_run.id), '{}'::jsonb);
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

COMMENT ON FUNCTION public.route_run_execution_manifest_build_v1(UUID)
  IS 'Canonical route_run execution-manifest builder with route-load scan-out reconciliation and departure audit state for executor/support surfaces.';

-------------------------------------------------------------------------------
-- 3) Route-stop read model exposes per-stop load scan status
-------------------------------------------------------------------------------

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
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::INT AS load_scan_count,
    MAX(se.captured_at) AS last_load_scanned_at
  FROM public.scan_events se
  WHERE se.organization_id = rs.organization_id
    AND se.route_run_id = rs.route_run_id
    AND lower(COALESCE(se.scan_type, '')) = 'load'
    AND (
      se.route_stop_id = rs.id
      OR (
        se.route_stop_id IS NULL
        AND rs.shipment_id IS NOT NULL
        AND se.shipment_id = rs.shipment_id
      )
    )
) AS load_scan
  ON TRUE
WHERE public.route_run_actor_can_read_v1(
  rs.organization_id,
  rs.route_run_id,
  rr.driver_user_id
);

COMMENT ON VIEW public.route_stops_visible_v1 IS
  'Executor-safe route_stop manifest projection scoped to the visible route inventory, including delivery-attempt outcomes, COD payment terms, and per-stop route-load scan-out state.';

REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM anon;
GRANT SELECT ON TABLE public.route_stops_visible_v1 TO authenticated, service_role;

CREATE OR REPLACE VIEW api.route_stops
WITH (security_invoker = true) AS
SELECT *
FROM public.route_stops_visible_v1;

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection with delivery-attempt, COD payment, and route-load scan-out metadata.';

REVOKE ALL ON api.route_stops FROM PUBLIC;
REVOKE ALL ON api.route_stops FROM anon;
GRANT SELECT ON api.route_stops TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Authenticated departure confirmation wrapper (fail closed)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_route_run_departure_v1(
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_actor_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_run_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_task_id UUID := NULL;
  v_ops_session_id UUID := NULL;
  v_route_run public.route_runs%ROWTYPE;
  v_has_routes_write BOOLEAN := FALSE;
  v_scan_out JSONB := '{}'::jsonb;
  v_existing_departure JSONB := '{}'::jsonb;
  v_route_departure JSONB := '{}'::jsonb;
  v_effective_status TEXT := NULL;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 requires object input'
      USING ERRCODE = '22023';
  END IF;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := v_org_id;
  END IF;

  PERFORM public.assert_capability_v1('tasks.complete', v_scope_type, v_scope_id);
  v_has_routes_write := public.user_has_capability_v1('routes.write', v_scope_type, v_scope_id);

  BEGIN
    v_route_run_id := NULLIF(btrim(COALESCE(v_input->>'route_run_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 invalid route_run_id'
      USING ERRCODE = '22P02';
  END;
  BEGIN
    v_route_stop_id := NULLIF(btrim(COALESCE(v_input->>'route_stop_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 invalid route_stop_id'
      USING ERRCODE = '22P02';
  END;
  BEGIN
    v_task_id := NULLIF(btrim(COALESCE(v_input->>'task_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 invalid task_id'
      USING ERRCODE = '22P02';
  END;
  BEGIN
    v_ops_session_id := NULLIF(btrim(COALESCE(v_input->>'ops_session_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 invalid ops_session_id'
      USING ERRCODE = '22P02';
  END;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 requires route_run_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 route_run % not found', v_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user() AND v_org_id IS NOT NULL AND v_route_run.organization_id IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 route_run % is outside the current organization', v_route_run_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.route_run_actor_can_read_v1(
    v_route_run.organization_id,
    v_route_run.id,
    v_route_run.driver_user_id
  ) THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 route_run % is not visible to the current actor', v_route_run_id
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type = 'tenant'
     AND v_route_run.driver_user_id IS NOT NULL
     AND v_route_run.driver_user_id <> v_actor_id
     AND NOT v_has_routes_write THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 requires route ownership'
      USING ERRCODE = '42501';
  END IF;

  IF lower(COALESCE(v_route_run.status, '')) IN ('completed', 'canceled') THEN
    RAISE EXCEPTION 'confirm_route_run_departure_v1 cannot mutate terminal route_run status %', v_route_run.status
      USING ERRCODE = '23514';
  END IF;

  IF v_route_stop_id IS NOT NULL THEN
    PERFORM 1
      FROM public.route_stops rs
     WHERE rs.id = v_route_stop_id
       AND rs.route_run_id = v_route_run.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirm_route_run_departure_v1 route_stop % is outside route_run %', v_route_stop_id, v_route_run_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_task_id IS NOT NULL THEN
    PERFORM 1
      FROM public.tasks t
      JOIN public.route_stops rs
        ON t.resource_type = 'route_stop'
       AND rs.id = t.resource_id
     WHERE t.id = v_task_id
       AND rs.route_run_id = v_route_run.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirm_route_run_departure_v1 task % is outside route_run %', v_task_id, v_route_run_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_ops_session_id IS NOT NULL THEN
    PERFORM 1
      FROM public.ops_sessions s
     WHERE s.id = v_ops_session_id
       AND s.organization_id = v_route_run.organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirm_route_run_departure_v1 ops_session % not found for route organization', v_ops_session_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  v_scan_out := COALESCE(public.route_run_scan_out_reconciliation_v1(v_route_run.id), '{}'::jsonb);
  IF COALESCE((v_scan_out->>'ready_for_departure')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'confirm_route_run_departure_v1 route_run % is not ready for departure (missing %, unexpected %)',
      v_route_run.id,
      COALESCE(v_scan_out->>'missing_stop_count', '0'),
      COALESCE(v_scan_out->>'unexpected_scan_count', '0')
      USING ERRCODE = '23514';
  END IF;

  v_existing_departure := COALESCE(v_route_run.metadata->'route_departure', '{}'::jsonb);
  IF jsonb_typeof(v_existing_departure) IS DISTINCT FROM 'object' THEN
    v_existing_departure := '{}'::jsonb;
  END IF;

  IF NULLIF(COALESCE(v_existing_departure->>'confirmed_at', ''), '') IS NOT NULL THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'route_run_id', v_route_run.id,
        'status', v_route_run.status,
        'started_at', v_route_run.started_at,
        'scan_out', v_scan_out,
        'route_departure', v_existing_departure
      )
    );
  END IF;

  v_effective_status :=
    CASE
      WHEN lower(COALESCE(v_route_run.status, '')) = 'planned' THEN 'in_progress'
      ELSE v_route_run.status
    END;

  v_route_departure := jsonb_strip_nulls(
    jsonb_build_object(
      'confirmed_at', workflow_now(),
      'confirmed_by_user_id', v_actor_id,
      'route_stop_id', v_route_stop_id,
      'task_id', v_task_id,
      'ops_session_id', v_ops_session_id,
      'scan_out', v_scan_out
    )
  );

  UPDATE public.route_runs rr
     SET status = v_effective_status,
         started_at = COALESCE(rr.started_at, workflow_now()),
         metadata = jsonb_set(
           COALESCE(rr.metadata, '{}'::jsonb),
           '{route_departure}',
           v_route_departure,
           TRUE
         ),
         updated_at = workflow_now()
   WHERE rr.id = v_route_run.id;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_id', v_route_run.id,
      'status', v_effective_status,
      'started_at', COALESCE(v_route_run.started_at, workflow_now()),
      'scan_out', v_scan_out,
      'route_departure', v_route_departure
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.confirm_route_run_departure_v1(JSONB)
  IS 'Confirm route departure after canonical route-load scans reconcile to the planned route_stop shipment set. Persists the departure audit snapshot under route_runs.metadata.route_departure.';

REVOKE ALL ON FUNCTION public.confirm_route_run_departure_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_route_run_departure_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.confirm_route_run_departure_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_route_run_departure_v1(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.ui_confirm_route_run_departure_v1(
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_run_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_confirm_route_run_departure_v1 requires object input'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_route_run_id := NULLIF(btrim(COALESCE(v_input->>'route_run_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'ui_confirm_route_run_departure_v1 invalid route_run_id'
      USING ERRCODE = '22P02';
  END;

  PERFORM 1
    FROM public.ui_route_run_visible_v1(v_route_run_id, 'read');

  RETURN public.confirm_route_run_departure_v1(v_input);
END;
$function$;

COMMENT ON FUNCTION public.ui_confirm_route_run_departure_v1(JSONB)
  IS 'Authenticated UI wrapper for canonical route departure confirmation. Fails closed on route visibility and scan-out readiness.';

REVOKE ALL ON FUNCTION public.ui_confirm_route_run_departure_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_confirm_route_run_departure_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_confirm_route_run_departure_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_confirm_route_run_departure_v1(
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_confirm_route_run_departure_v1($1);
$function$;

REVOKE ALL ON FUNCTION api.ui_confirm_route_run_departure_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_confirm_route_run_departure_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_confirm_route_run_departure_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604101500_uc082_route_run_scan_out_departure_gate_v1'));
COMMIT;
