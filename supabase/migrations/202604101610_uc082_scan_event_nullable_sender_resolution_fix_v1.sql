-- Plan: Batch 7 field execution platform hardening / Step: E08
-- Migration: record_scan_event_v1 nullable sender shipment resolution fix
-- Purpose:
-- - Keep route-load scan-out canonical when a shipment row exists but sender_id is null.
-- - Treat sender_id as optional policy context, not as the existence proof for shipment ownership.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101610_uc082_scan_event_nullable_sender_resolution_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := $old$
  IF v_client_id IS NOT NULL AND v_shipment_id IS NOT NULL THEN
    IF v_sender_id IS NULL THEN
      SELECT s.sender_id INTO v_sender_id
      FROM public.shipments s
      WHERE s.id = v_shipment_id
        AND s.client_id = v_client_id
        AND s.organization_id = v_org;
    END IF;
    IF v_sender_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1: shipment not found for client/org' USING ERRCODE = '23503';
    END IF;
  END IF;
$old$;
  v_new TEXT := $new$
  IF v_client_id IS NOT NULL AND v_shipment_id IS NOT NULL THEN
    DECLARE
      v_shipment_found BOOLEAN := FALSE;
    BEGIN
      SELECT s.sender_id, TRUE
        INTO v_sender_id, v_shipment_found
      FROM public.shipments s
      WHERE s.id = v_shipment_id
        AND s.client_id = v_client_id
        AND s.organization_id = v_org;

      IF v_shipment_found IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'record_scan_event_v1: shipment not found for client/org' USING ERRCODE = '23503';
      END IF;
    END;
  END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef('public.record_scan_event_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'Unexpected record_scan_event_v1 definition shape while fixing nullable sender resolution';
  END IF;

  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604101610_uc082_scan_event_nullable_sender_resolution_fix_v1'));
COMMIT;
