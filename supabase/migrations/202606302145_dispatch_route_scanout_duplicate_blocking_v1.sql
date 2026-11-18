-- Migration: Dispatch route scanout duplicate blocking v1
-- Purpose:
--   - Treat duplicate route-load scans as a non-clean reconciliation state so
--     departure readiness stays blocked until the route-run load is clean.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606302145_dispatch_route_scanout_duplicate_blocking_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
           AND v_duplicate_scan_count = 0
           AND v_unexpected_scan_count = 0
          THEN TRUE
          ELSE FALSE
        END
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID)
  IS 'Canonical route-load scan reconciliation for a route run. Compares load scan_events against the planned route_stop shipment set and reports missing, duplicate, and unexpected scans; departure readiness requires a clean non-duplicate load.';

REVOKE ALL ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_scan_out_reconciliation_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606302145_dispatch_route_scanout_duplicate_blocking_v1'));
COMMIT;
