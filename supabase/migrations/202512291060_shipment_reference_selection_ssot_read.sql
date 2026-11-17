-- Plan: PLAN-202512-shipment-references-ssot / Step: S04
-- Migration: Shipment reference selection SSOT (canonical-first)
-- Purpose:
--   - Prefer canonical shipment_reference_numbers for client/carrier reference reads
--     (shipment columns remain compatibility fallback).
--   - Tighten function execution privileges (least privilege).
-- Date: 2025-12-29

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.select_shipment_reference_number_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_shipment_id UUID,
  p_tracking_number TEXT,
  p_client_reference_number TEXT,
  p_carrier_reference_number TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_context JSONB;
  v_policy JSONB;
  v_order JSONB;
  v_key TEXT;
  v_candidate TEXT;
  v_fallback TEXT;
BEGIN
  v_context := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', p_organization_id,
    'client_id', p_client_id,
    'sender_id', p_sender_id
  ));

  SELECT value INTO v_policy
  FROM public.resolve_settings_row_from_context('shipment_reference_policy', v_context)
  LIMIT 1;

  v_order := v_policy #> '{label,reference_order}';
  IF v_order IS NULL OR jsonb_typeof(v_order) <> 'array' THEN
    v_order := jsonb_build_array('client_reference_number', 'carrier_reference_number', 'tracking_number');
  END IF;

  FOR v_key IN
    SELECT jsonb_array_elements_text(v_order)
  LOOP
    v_key := NULLIF(btrim(v_key), '');
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    v_candidate := NULL;
    v_fallback := NULL;

    IF v_key = 'tracking_number' THEN
      v_candidate := NULLIF(btrim(p_tracking_number), '');
    ELSIF v_key IN ('client_reference_number', 'carrier_reference_number') THEN
      v_fallback := CASE
        WHEN v_key = 'client_reference_number' THEN NULLIF(btrim(p_client_reference_number), '')
        ELSE NULLIF(btrim(p_carrier_reference_number), '')
      END;

      -- Canonical-first: if shipment columns are present, prefer the canonical row
      -- matching that current value; otherwise pick the most recent value for the type.
      SELECT srn.reference_value INTO v_candidate
      FROM public.shipment_reference_numbers srn
      WHERE srn.client_id = p_client_id
        AND srn.shipment_id = p_shipment_id
        AND srn.reference_type = v_key
        AND (
          v_fallback IS NULL
          OR srn.reference_value_upper = upper(v_fallback)
        )
      ORDER BY srn.created_at DESC, srn.id DESC
      LIMIT 1;

      v_candidate := COALESCE(NULLIF(btrim(v_candidate), ''), v_fallback);
    ELSE
      SELECT srn.reference_value INTO v_candidate
      FROM public.shipment_reference_numbers srn
      WHERE srn.client_id = p_client_id
        AND srn.shipment_id = p_shipment_id
        AND srn.reference_type = v_key
      ORDER BY srn.created_at ASC, srn.id ASC
      LIMIT 1;

      v_candidate := NULLIF(btrim(v_candidate), '');
    END IF;

    IF v_candidate IS NOT NULL THEN
      RETURN v_candidate;
    END IF;
  END LOOP;

  RETURN COALESCE(
    NULLIF(btrim(p_client_reference_number), ''),
    NULLIF(btrim(p_carrier_reference_number), ''),
    NULLIF(btrim(p_tracking_number), ''),
    NULL
  );
END;
$$;

COMMENT ON FUNCTION public.select_shipment_reference_number_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT)
  IS 'Select a shipment reference number via ladder-resolved shipment_reference_policy reference_order (canonical-first via shipment_reference_numbers; fallback to shipment columns + tracking).';

REVOKE EXECUTE ON FUNCTION public.select_shipment_reference_number_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.select_shipment_reference_number_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.select_shipment_reference_number_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.select_shipment_reference_number_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) TO label_renderer_role;
GRANT EXECUTE ON FUNCTION public.select_shipment_reference_number_v1(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

COMMIT;

