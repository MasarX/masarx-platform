-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Scan events warehouse links v1 (handling_units + warehouse_transfers)
-- Date: 2026-01-26
--
-- Goals:
--   - Extend scan_events SSOT ledger to reference warehouse chain-of-custody entities:
--       - handling_units (bags/totes/cages/pallets)
--       - warehouse_transfers (inter-branch transfer manifests)
--   - Avoid redundant event tables (no handling_unit_events). Scans remain the immutable ledger.
--   - Keep least-privilege: writes only through record_scan_event_v1 (tenant-only + policy gates).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601261200_scan_events_warehouse_links_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Schema: add optional link columns
-------------------------------------------------------------------------------

ALTER TABLE public.scan_events
  ADD COLUMN IF NOT EXISTS handling_unit_id UUID,
  ADD COLUMN IF NOT EXISTS warehouse_transfer_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'scan_events'
      AND c.conname = 'scan_events_handling_unit_id_fkey'
  ) THEN
    ALTER TABLE public.scan_events
      ADD CONSTRAINT scan_events_handling_unit_id_fkey
      FOREIGN KEY (handling_unit_id)
      REFERENCES public.handling_units(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'scan_events'
      AND c.conname = 'scan_events_warehouse_transfer_id_fkey'
  ) THEN
    ALTER TABLE public.scan_events
      ADD CONSTRAINT scan_events_warehouse_transfer_id_fkey
      FOREIGN KEY (warehouse_transfer_id)
      REFERENCES public.warehouse_transfers(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scan_events_handling_unit_time
  ON public.scan_events (handling_unit_id, captured_at DESC)
  WHERE handling_unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scan_events_warehouse_transfer_time
  ON public.scan_events (warehouse_transfer_id, captured_at DESC)
  WHERE warehouse_transfer_id IS NOT NULL;

-------------------------------------------------------------------------------
-- 2) RPC: record_scan_event_v1 accepts/resolves warehouse links
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_scan_event_v1(
  p_scan JSONB
)
RETURNS TABLE (
  scan_event_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_scan, '{}'::jsonb);
  v_id UUID := gen_random_uuid();
  v_created BOOLEAN := TRUE;

  v_device_id UUID := NULL;
  v_run_id UUID := NULL;
  v_stop_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_client_id UUID := NULL;
  v_shipment_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_artifact_id UUID := NULL;
  v_handling_unit_id UUID := NULL;
  v_handling_unit_code TEXT := NULL;
  v_transfer_id UUID := NULL;
  v_transfer_code TEXT := NULL;

  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_meta JSONB := '{}'::jsonb;

  v_scan_type TEXT := NULL;
  v_barcode TEXT := NULL;
  v_tracking_upper TEXT := NULL;

  v_lat DOUBLE PRECISION := NULL;
  v_lng DOUBLE PRECISION := NULL;
  v_accuracy INT := NULL;
  v_captured_at TIMESTAMPTZ := NULL;

  v_policy_ctx JSONB;
  v_ingest RECORD;
  v_scan_policy RECORD;
  v_require_device BOOLEAN := NULL;
  v_max_payload INT := NULL;
  v_allowed JSONB := NULL;

  v_unit_branch_id UUID := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'record_scan_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_device_id := NULLIF(btrim(COALESCE(v_in->>'device_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_device_id := NULL; END;
  BEGIN v_run_id := NULLIF(btrim(COALESCE(v_in->>'route_run_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_run_id := NULL; END;
  BEGIN v_stop_id := NULLIF(btrim(COALESCE(v_in->>'route_stop_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_stop_id := NULL; END;
  BEGIN v_branch_id := NULLIF(btrim(COALESCE(v_in->>'branch_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_client_id := NULLIF(btrim(COALESCE(v_in->>'client_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_shipment_id := NULLIF(btrim(COALESCE(v_in->>'shipment_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_artifact_id := NULLIF(btrim(COALESCE(v_in->>'artifact_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_artifact_id := NULL; END;
  BEGIN v_handling_unit_id := NULLIF(btrim(COALESCE(v_in->>'handling_unit_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_handling_unit_id := NULL; END;
  BEGIN v_transfer_id := NULLIF(btrim(COALESCE(v_in->>'warehouse_transfer_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_transfer_id := NULL; END;

  v_handling_unit_code := NULLIF(btrim(COALESCE(v_in->>'handling_unit_code', '')), '');
  v_transfer_code := NULLIF(btrim(COALESCE(v_in->>'warehouse_transfer_code', '')), '');

  v_scan_type := lower(NULLIF(btrim(COALESCE(v_in->>'scan_type', '')), ''));
  v_barcode := NULLIF(btrim(COALESCE(v_in->>'barcode', '')), '');

  BEGIN v_lat := NULLIF(btrim(COALESCE(v_in->>'lat', '')), '')::double precision; EXCEPTION WHEN others THEN v_lat := NULL; END;
  BEGIN v_lng := NULLIF(btrim(COALESCE(v_in->>'lng', '')), '')::double precision; EXCEPTION WHEN others THEN v_lng := NULL; END;
  BEGIN v_accuracy := NULLIF(btrim(COALESCE(v_in->>'accuracy_m', '')), '')::int; EXCEPTION WHEN others THEN v_accuracy := NULL; END;
  BEGIN v_captured_at := NULLIF(btrim(COALESCE(v_in->>'captured_at', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_captured_at := NULL; END;

  IF v_captured_at IS NULL THEN
    v_captured_at := now();
  END IF;

  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) <> 'object' THEN v_meta := '{}'::jsonb; END IF;

  IF v_scan_type IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires scan_type' USING ERRCODE = '23514';
  END IF;
  IF v_barcode IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires barcode' USING ERRCODE = '23514';
  END IF;

  -- Optional: derive shipment/client from route_stop if provided.
  IF v_stop_id IS NOT NULL THEN
    DECLARE
      v_stop_org UUID;
      v_stop_client UUID;
      v_stop_ship UUID;
      v_stop_run UUID;
    BEGIN
      SELECT rs.organization_id, rs.client_id, rs.shipment_id, rs.route_run_id
        INTO v_stop_org, v_stop_client, v_stop_ship, v_stop_run
        FROM public.route_stops rs
       WHERE rs.id = v_stop_id;

      IF v_stop_org IS NULL THEN
        RAISE EXCEPTION 'record_scan_event_v1 route_stop_id % not found', v_stop_id USING ERRCODE = '23503';
      END IF;
      IF v_stop_org IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'record_scan_event_v1: organization mismatch (event org %, route_stop org %)', v_org, v_stop_org
          USING ERRCODE = '23514';
      END IF;

      IF v_client_id IS NULL AND v_shipment_id IS NULL THEN
        v_client_id := v_stop_client;
        v_shipment_id := v_stop_ship;
      ELSIF v_client_id IS NOT NULL AND v_shipment_id IS NOT NULL THEN
        IF v_client_id IS DISTINCT FROM v_stop_client OR v_shipment_id IS DISTINCT FROM v_stop_ship THEN
          RAISE EXCEPTION 'record_scan_event_v1: shipment mismatch vs route_stop' USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'record_scan_event_v1 requires both shipment_id and client_id when linking to a shipment' USING ERRCODE = '23514';
      END IF;

      IF v_run_id IS NULL THEN
        v_run_id := v_stop_run;
      ELSIF v_run_id IS DISTINCT FROM v_stop_run THEN
        RAISE EXCEPTION 'record_scan_event_v1: route_run_id mismatch vs route_stop' USING ERRCODE = '23514';
      END IF;
    END;
  END IF;

  -- Optional: when not linked via route_stop and no shipment/client provided, try to resolve by barcode (tracking number).
  IF v_stop_id IS NULL AND v_client_id IS NULL AND v_shipment_id IS NULL THEN
    v_tracking_upper := upper(NULLIF(btrim(split_part(v_barcode, ':', 1)), ''));
    IF v_tracking_upper IS NOT NULL THEN
      SELECT s.client_id, s.id, s.sender_id
        INTO v_client_id, v_shipment_id, v_sender_id
        FROM public.shipments s
       WHERE s.organization_id = v_org
         AND s.tracking_upper = v_tracking_upper
       LIMIT 1;
    END IF;
  END IF;

  -- Optional: resolve handling_unit / transfer by explicit id/code first, else barcode match (best-effort).
  IF v_handling_unit_id IS NULL AND v_handling_unit_code IS NOT NULL THEN
    SELECT hu.id, hu.branch_id
      INTO v_handling_unit_id, v_unit_branch_id
      FROM public.handling_units hu
     WHERE hu.organization_id = v_org
       AND hu.code = v_handling_unit_code
     LIMIT 1;
    IF v_handling_unit_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1: handling_unit_code not found for org' USING ERRCODE = '23503';
    END IF;
  ELSIF v_handling_unit_id IS NOT NULL THEN
    SELECT hu.branch_id
      INTO v_unit_branch_id
      FROM public.handling_units hu
     WHERE hu.id = v_handling_unit_id
       AND hu.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: handling_unit_id not found for org' USING ERRCODE = '23503';
    END IF;
  ELSIF v_client_id IS NULL AND v_shipment_id IS NULL THEN
    SELECT hu.id, hu.branch_id
      INTO v_handling_unit_id, v_unit_branch_id
      FROM public.handling_units hu
     WHERE hu.organization_id = v_org
       AND hu.code = v_barcode
     LIMIT 1;
  END IF;

  IF v_transfer_id IS NULL AND v_transfer_code IS NOT NULL THEN
    SELECT wt.id
      INTO v_transfer_id
      FROM public.warehouse_transfers wt
     WHERE wt.organization_id = v_org
       AND wt.transfer_code = v_transfer_code
     LIMIT 1;
    IF v_transfer_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1: warehouse_transfer_code not found for org' USING ERRCODE = '23503';
    END IF;
  ELSIF v_transfer_id IS NOT NULL THEN
    PERFORM 1
    FROM public.warehouse_transfers wt
    WHERE wt.id = v_transfer_id
      AND wt.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: warehouse_transfer_id not found for org' USING ERRCODE = '23503';
    END IF;
  ELSIF v_client_id IS NULL AND v_shipment_id IS NULL THEN
    SELECT wt.id
      INTO v_transfer_id
      FROM public.warehouse_transfers wt
     WHERE wt.organization_id = v_org
       AND wt.transfer_code = v_barcode
     LIMIT 1;
  END IF;

  -- Derive branch_id from handling unit when not provided (best-effort).
  IF v_branch_id IS NULL AND v_unit_branch_id IS NOT NULL THEN
    v_branch_id := v_unit_branch_id;
  END IF;

  -- Validate device ownership when provided.
  IF v_device_id IS NOT NULL THEN
    PERFORM 1
    FROM public.user_devices d
    WHERE d.id = v_device_id
      AND d.organization_id = v_org
      AND d.user_id = v_user;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1 device_id is not owned by current user' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Validate route_run/branch/artifact belong to org (best-effort guardrail).
  IF v_run_id IS NOT NULL THEN
    PERFORM 1 FROM public.route_runs rr WHERE rr.id = v_run_id AND rr.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: route_run not found for org' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF v_branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches b WHERE b.id = v_branch_id AND b.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: branch not found for org' USING ERRCODE = '23503';
    END IF;
  ELSIF v_run_id IS NOT NULL THEN
    SELECT rr.branch_id INTO v_branch_id
    FROM public.route_runs rr
    WHERE rr.id = v_run_id AND rr.organization_id = v_org;
  END IF;
  IF v_artifact_id IS NOT NULL THEN
    PERFORM 1 FROM public.artifacts a WHERE a.id = v_artifact_id AND a.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: artifact not found for org' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF (v_shipment_id IS NULL) IS DISTINCT FROM (v_client_id IS NULL) THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires both shipment_id and client_id when linking to a shipment' USING ERRCODE = '23514';
  END IF;

  IF v_client_id IS NOT NULL THEN
    PERFORM 1 FROM public.clients c WHERE c.id = v_client_id AND c.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: client not found for org' USING ERRCODE = '23503';
    END IF;
  END IF;

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

  -- Resolve ingest/scan policies (ladder-resolved; branch-aware via resource_id=branch_id when available).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org,
    'user_id', v_user,
    'resource_id', v_branch_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id,
    'event_type', 'scan_event'
  ));

  SELECT * INTO v_ingest FROM public.resolve_mobile_ingest_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_ingest.value IS NOT NULL THEN
    IF COALESCE((v_ingest.value->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by mobile_ingest_policy.enabled=false' USING ERRCODE = '42501';
    END IF;

    v_require_device := NULLIF(v_ingest.value->>'require_device', '')::boolean;
    IF COALESCE(v_require_device, FALSE) IS TRUE AND v_device_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1 requires device_id by policy' USING ERRCODE = '42501';
    END IF;

    BEGIN v_max_payload := NULLIF(v_ingest.value->>'max_payload_bytes', '')::int; EXCEPTION WHEN others THEN v_max_payload := NULL; END;
    IF v_max_payload IS NOT NULL AND octet_length(v_in::text) > v_max_payload THEN
      RAISE EXCEPTION 'record_scan_event_v1 payload too large for policy' USING ERRCODE = '22001';
    END IF;

    v_allowed := v_ingest.value->'accepted_event_types';
    IF jsonb_typeof(v_allowed) = 'array' AND NOT (v_allowed ? 'scan_event') THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by mobile_ingest_policy.accepted_event_types' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_scan_policy FROM public.resolve_scan_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_scan_policy.value IS NOT NULL THEN
    IF COALESCE((v_scan_policy.value->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by scan_policy.enabled=false' USING ERRCODE = '42501';
    END IF;

    v_allowed := v_scan_policy.value->'accepted_scan_types';
    IF jsonb_typeof(v_allowed) = 'array' AND NOT (v_allowed ? v_scan_type) THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by scan_policy.accepted_scan_types' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Idempotency short-circuit.
  INSERT INTO public.scan_event_dedupe (organization_id, idempotency_key, scan_event_id, created_at)
  VALUES (v_org, v_idempotency, v_id, now())
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT d.scan_event_id INTO v_id
    FROM public.scan_event_dedupe d
    WHERE d.organization_id = v_org AND d.idempotency_key = v_idempotency
    LIMIT 1;
    RETURN QUERY SELECT v_id, FALSE;
    RETURN;
  END IF;

  INSERT INTO public.scan_events (
    id, organization_id, actor_user_id, device_id,
    route_run_id, route_stop_id, branch_id,
    client_id, shipment_id,
    handling_unit_id, warehouse_transfer_id,
    artifact_id,
    scan_type, barcode,
    coordinates, accuracy_m,
    idempotency_key, metadata,
    captured_at, received_at, created_at
  ) VALUES (
    v_id, v_org, v_user, v_device_id,
    v_run_id, v_stop_id, v_branch_id,
    v_client_id, v_shipment_id,
    v_handling_unit_id, v_transfer_id,
    v_artifact_id,
    v_scan_type, v_barcode,
    CASE
      WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL
        THEN ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography
      ELSE NULL
    END,
    v_accuracy,
    v_idempotency, v_meta,
    v_captured_at, now(), now()
  );

  RETURN QUERY SELECT v_id, TRUE;
END;
$function$;

COMMENT ON FUNCTION public.record_scan_event_v1(JSONB)
  IS 'Insert a scan event (SSOT ledger) with idempotency via scan_event_dedupe; policy-resolved; tenant-only; can link scans to handling units and warehouse transfers.';
REVOKE ALL ON FUNCTION public.record_scan_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_scan_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_scan_event_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601261200_scan_events_warehouse_links_v1'));
COMMIT;
