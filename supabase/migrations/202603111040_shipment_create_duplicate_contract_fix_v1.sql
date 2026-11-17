-- Plan: PLAN-202603-webhook-shipment-ingestion-contract-hardening / Step: S04
-- Migration: Shipment create duplicate contract fixup
-- Purpose:
--   - Qualify duplicate-resolver source columns to avoid ambiguity with output columns.
--   - Keep the shared duplicate contract stable after local verification exposed the issue.
-- Date: 2026-03-11

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_shipment_create_duplicate_v1(
  p_client_id UUID,
  p_tracking_number TEXT DEFAULT NULL,
  p_client_reference_number TEXT DEFAULT NULL
)
RETURNS TABLE (
  shipment_id UUID,
  tracking_number TEXT,
  operation TEXT,
  matched_on TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_tracking_shipment_id UUID;
  v_tracking_match_number TEXT;
  v_client_reference_shipment_id UUID;
  v_client_reference_match_number TEXT;
  v_tracking_input TEXT := NULLIF(btrim(p_tracking_number), '');
  v_client_reference_input TEXT := NULLIF(btrim(p_client_reference_number), '');
BEGIN
  IF p_client_id IS NULL THEN
    RETURN;
  END IF;

  IF v_tracking_input IS NOT NULL THEN
    SELECT tracking_match.shipment_id, tracking_match.tracking_number
      INTO v_tracking_shipment_id, v_tracking_match_number
      FROM public.find_shipment_by_tracking_v1(p_client_id, v_tracking_input) AS tracking_match
     LIMIT 1;
  END IF;

  IF v_client_reference_input IS NOT NULL THEN
    SELECT client_reference_match.shipment_id, client_reference_match.tracking_number
      INTO v_client_reference_shipment_id, v_client_reference_match_number
      FROM public.find_shipment_by_client_reference_v1(p_client_id, v_client_reference_input) AS client_reference_match
     LIMIT 1;
  END IF;

  IF v_tracking_shipment_id IS NOT NULL
     AND v_client_reference_shipment_id IS NOT NULL
     AND v_tracking_shipment_id <> v_client_reference_shipment_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'shipment_create_duplicate_key_mismatch',
      DETAIL = jsonb_build_object(
        'client_id', p_client_id,
        'tracking_number', v_tracking_input,
        'tracking_shipment_id', v_tracking_shipment_id,
        'client_reference_number', v_client_reference_input,
        'client_reference_shipment_id', v_client_reference_shipment_id
      )::text,
      HINT = 'tracking_number and client_reference_number must resolve to the same shipment or one key must be absent';
  END IF;

  IF v_tracking_shipment_id IS NOT NULL THEN
    shipment_id := v_tracking_shipment_id;
    tracking_number := v_tracking_match_number;
    operation := 'reused';
    matched_on := CASE
      WHEN v_client_reference_shipment_id IS NOT NULL THEN 'tracking+client_reference'
      ELSE 'tracking'
    END;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_client_reference_shipment_id IS NOT NULL THEN
    shipment_id := v_client_reference_shipment_id;
    tracking_number := COALESCE(v_client_reference_match_number, v_tracking_input);
    operation := 'reused_client_reference';
    matched_on := 'client_reference';
    RETURN NEXT;
    RETURN;
  END IF;
END;
$$;

COMMIT;
