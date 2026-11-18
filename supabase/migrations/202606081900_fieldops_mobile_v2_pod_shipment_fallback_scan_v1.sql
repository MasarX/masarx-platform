-- Date: 2026-06-08
--
-- Align Mobile V2 stop-detail readback and POD closeout writes for shipments
-- that do not yet have explicit shipment_boxes rows. The stop-detail resolver
-- exposes a shipment-level fallback parcel with code = tracking number; the
-- proof write path must accept that same row-driven code and map it back to
-- canonical box 1 after ensure_shipment_boxes materializes box lineage.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606081900_fieldops_mobile_v2_pod_shipment_fallback_scan_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_definition TEXT;
  v_updated TEXT;
BEGIN
  SELECT pg_get_functiondef('public.submit_fieldops_proof_v1(uuid,text,jsonb,uuid)'::regprocedure)
    INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 is required before shipment fallback scan patch'
      USING ERRCODE = '42883';
  END IF;

  IF position('v_scan_used_shipment_fallback' IN v_definition) > 0 THEN
    v_updated := v_definition;
  ELSE
    v_updated := replace(
      v_definition,
      '  v_expected_scan_code_count INT := 0;
  v_delivered_box_ids JSONB := ''[]''::jsonb;',
      '  v_expected_scan_code_count INT := 0;
  v_had_shipment_boxes BOOLEAN := FALSE;
  v_scan_used_shipment_fallback BOOLEAN := FALSE;
  v_delivered_box_ids JSONB := ''[]''::jsonb;'
    );

    v_updated := replace(
      v_updated,
      '      PERFORM 1
        FROM public.ensure_shipment_boxes(v_shipment_id, GREATEST(COALESCE(v_box_count, 1), 1));

      SELECT COALESCE(array_agg(sb.barcode ORDER BY sb.box_number), ARRAY[]::text[])
        INTO v_expected_scan_codes
        FROM public.shipment_boxes sb
       WHERE sb.shipment_id = v_shipment_id
         AND sb.organization_id = v_org;

      IF COALESCE(array_length(v_expected_scan_codes, 1), 0) = 0 THEN
        SELECT COALESCE(array_agg(v_tracking_number || '':'' || box_no.value::text ORDER BY box_no.value), ARRAY[]::text[])
          INTO v_expected_scan_codes
          FROM generate_series(1, GREATEST(COALESCE(v_box_count, 1), 1)) AS box_no(value);
      END IF;',
      '      SELECT EXISTS (
        SELECT 1
          FROM public.shipment_boxes sb
         WHERE sb.shipment_id = v_shipment_id
           AND sb.organization_id = v_org
      )
        INTO v_had_shipment_boxes;

      PERFORM 1
        FROM public.ensure_shipment_boxes(v_shipment_id, GREATEST(COALESCE(v_box_count, 1), 1));

      SELECT COALESCE(array_agg(sb.barcode ORDER BY sb.box_number), ARRAY[]::text[])
        INTO v_expected_scan_codes
        FROM public.shipment_boxes sb
       WHERE sb.shipment_id = v_shipment_id
         AND sb.organization_id = v_org;

      IF NOT v_had_shipment_boxes
         AND GREATEST(COALESCE(v_box_count, 1), 1) = 1
         AND NULLIF(btrim(COALESCE(v_tracking_number, '''')), '''') IS NOT NULL
         AND v_tracking_number = ANY(v_scan_codes) THEN
        v_expected_scan_codes := ARRAY[v_tracking_number];
        v_scan_used_shipment_fallback := TRUE;
      ELSIF COALESCE(array_length(v_expected_scan_codes, 1), 0) = 0 THEN
        SELECT COALESCE(array_agg(v_tracking_number || '':'' || box_no.value::text ORDER BY box_no.value), ARRAY[]::text[])
          INTO v_expected_scan_codes
          FROM generate_series(1, GREATEST(COALESCE(v_box_count, 1), 1)) AS box_no(value);
      END IF;'
    );

    v_updated := replace(
      v_updated,
      '       WHERE sb.shipment_id = v_shipment_id
         AND sb.organization_id = v_org
         AND sb.barcode = ANY(v_scan_codes);',
      '       WHERE sb.shipment_id = v_shipment_id
         AND sb.organization_id = v_org
         AND (
           sb.barcode = ANY(v_scan_codes)
           OR (
             v_scan_used_shipment_fallback
             AND sb.box_number = 1
             AND v_tracking_number = ANY(v_scan_codes)
           )
         );'
    );

    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'submit_fieldops_proof_v1 shipment fallback scan patch marker not found'
        USING ERRCODE = '42883';
    END IF;
  END IF;

  v_updated := replace(
    v_updated,
    '      IF jsonb_typeof(v_evidence->''delivered_box_ids'') = ''array''
         AND v_evidence->''delivered_box_ids'' <> v_delivered_box_ids THEN
        RAISE EXCEPTION ''submit_fieldops_proof_v1: scan_codes must match delivered_box_ids''
          USING ERRCODE = ''23514'';
      END IF;',
    '      IF jsonb_typeof(v_evidence->''delivered_box_ids'') = ''array''
         AND v_evidence->''delivered_box_ids'' <> v_delivered_box_ids
         AND NOT (
           v_scan_used_shipment_fallback
           AND v_evidence->''delivered_box_ids'' = jsonb_build_array(v_shipment_id)
         ) THEN
        RAISE EXCEPTION ''submit_fieldops_proof_v1: scan_codes must match delivered_box_ids''
          USING ERRCODE = ''23514'';
      END IF;'
  );

  EXECUTE v_updated;
END $$;

REVOKE ALL ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_proof_v1(
  p_stop_id UUID,
  p_outcome TEXT,
  p_evidence JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key UUID DEFAULT gen_random_uuid()
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_proof_v1(p_stop_id, p_outcome, p_evidence, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606081900_fieldops_mobile_v2_pod_shipment_fallback_scan_v1'));
COMMIT;
