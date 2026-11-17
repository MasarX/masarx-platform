-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC guardrails for ops sessions + mobile ingest RPCs v1
-- Date: 2026-01-30
--
-- Why:
--   - Driver/warehouse/branch apps rely on device registration + telemetry (pings/scans) and ops sessions.
--   - These RPCs mutate operational ledgers and should be least-privilege.
--   - Enforce RBAC via stable permission predicate user_has_permission_v1 (row-driven).
--
-- Guard:
--   - Require tasks.complete permission for tenant users invoking operational RPCs:
--     register_user_device_v1, record_location_ping_v1, record_scan_event_v1,
--     open_ops_session_v1, transition_ops_session_v1.
--   - platform/service_role bypass is handled by user_has_permission_v1 (incremental rollout pattern).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300100_rbac_ops_sessions_mobile_ingest_guardrails_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) register_user_device_v1: require tasks.complete permission
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_user_device_v1(
  p_device JSONB
)
RETURNS TABLE (
  device_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_device, '{}'::jsonb);
  v_id UUID := gen_random_uuid();
  v_created BOOLEAN := TRUE;

  v_platform TEXT := NULL;
  v_ident TEXT := NULL;
  v_label TEXT := NULL;
  v_push TEXT := NULL;
  v_app TEXT := NULL;
  v_os TEXT := NULL;
  v_meta JSONB := '{}'::jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'register_user_device_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
    RAISE EXCEPTION 'register_user_device_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'register_user_device_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  v_platform := lower(NULLIF(btrim(COALESCE(v_in->>'device_platform', '')), ''));
  v_ident := NULLIF(btrim(COALESCE(v_in->>'device_identifier_sha256', '')), '');
  v_label := NULLIF(btrim(COALESCE(v_in->>'device_label', '')), '');
  v_push := NULLIF(btrim(COALESCE(v_in->>'push_token', '')), '');
  v_app := NULLIF(btrim(COALESCE(v_in->>'app_version', '')), '');
  v_os := NULLIF(btrim(COALESCE(v_in->>'os_version', '')), '');
  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) <> 'object' THEN v_meta := '{}'::jsonb; END IF;

  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 missing device_platform' USING ERRCODE = '23514';
  END IF;
  IF v_ident IS NULL THEN
    RAISE EXCEPTION 'register_user_device_v1 missing device_identifier_sha256' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.user_devices (
    id, organization_id, user_id,
    device_platform, device_identifier_sha256, device_label,
    push_token, app_version, os_version,
    last_seen_at, metadata, created_at, updated_at
  ) VALUES (
    v_id, v_org, v_user,
    v_platform, v_ident, v_label,
    v_push, v_app, v_os,
    now(), v_meta, now(), now()
  )
  ON CONFLICT (organization_id, user_id, device_identifier_sha256) DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT v_id, TRUE;
    RETURN;
  END IF;

  v_created := FALSE;
  UPDATE public.user_devices d
     SET push_token = COALESCE(v_push, d.push_token),
         device_label = COALESCE(v_label, d.device_label),
         app_version = COALESCE(v_app, d.app_version),
         os_version = COALESCE(v_os, d.os_version),
         last_seen_at = now(),
         metadata = COALESCE(d.metadata, '{}'::jsonb) || v_meta,
         updated_at = now()
   WHERE d.organization_id = v_org
     AND d.user_id = v_user
     AND d.device_identifier_sha256 = v_ident
   RETURNING d.id INTO v_id;

  RETURN QUERY SELECT v_id, v_created;
END;
$function$;

COMMENT ON FUNCTION public.register_user_device_v1(JSONB)
  IS 'Register or update a user device (push token + versions). Idempotent by (org,user,device_identifier_sha256). Tenant-only. Enforces RBAC tasks.complete permission.';

REVOKE ALL ON FUNCTION public.register_user_device_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_user_device_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_user_device_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) record_location_ping_v1: require tasks.complete permission
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_location_ping_v1(
  p_ping JSONB
)
RETURNS TABLE (
  location_ping_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_ping, '{}'::jsonb);
  v_id UUID := gen_random_uuid();
  v_created BOOLEAN := TRUE;

  v_device_id UUID := NULL;
  v_run_id UUID := NULL;
  v_stop_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_meta JSONB := '{}'::jsonb;

  v_lat DOUBLE PRECISION := NULL;
  v_lng DOUBLE PRECISION := NULL;
  v_accuracy INT := NULL;
  v_speed NUMERIC := NULL;
  v_heading INT := NULL;
  v_captured_at TIMESTAMPTZ := NULL;

  v_policy_ctx JSONB;
  v_ingest RECORD;
  v_track RECORD;
  v_require_device BOOLEAN := NULL;
  v_max_payload INT := NULL;
  v_allowed JSONB := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'record_location_ping_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_location_ping_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'record_location_ping_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
    RAISE EXCEPTION 'record_location_ping_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'record_location_ping_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'record_location_ping_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  BEGIN v_device_id := NULLIF(v_in->>'device_id', '')::uuid; EXCEPTION WHEN others THEN v_device_id := NULL; END;
  BEGIN v_run_id := NULLIF(v_in->>'route_run_id', '')::uuid; EXCEPTION WHEN others THEN v_run_id := NULL; END;
  BEGIN v_stop_id := NULLIF(v_in->>'route_stop_id', '')::uuid; EXCEPTION WHEN others THEN v_stop_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_in->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;

  BEGIN v_lat := NULLIF(v_in->>'lat', '')::double precision; EXCEPTION WHEN others THEN v_lat := NULL; END;
  BEGIN v_lng := NULLIF(v_in->>'lng', '')::double precision; EXCEPTION WHEN others THEN v_lng := NULL; END;
  BEGIN v_accuracy := NULLIF(v_in->>'accuracy_m', '')::int; EXCEPTION WHEN others THEN v_accuracy := NULL; END;
  BEGIN v_speed := NULLIF(v_in->>'speed_mps', '')::numeric; EXCEPTION WHEN others THEN v_speed := NULL; END;
  BEGIN v_heading := NULLIF(v_in->>'heading_deg', '')::int; EXCEPTION WHEN others THEN v_heading := NULL; END;
  BEGIN v_captured_at := NULLIF(v_in->>'captured_at', '')::timestamptz; EXCEPTION WHEN others THEN v_captured_at := NULL; END;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    RAISE EXCEPTION 'record_location_ping_v1 requires lat/lng' USING ERRCODE = '23514';
  END IF;
  IF v_captured_at IS NULL THEN
    v_captured_at := now();
  END IF;

  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) <> 'object' THEN v_meta := '{}'::jsonb; END IF;

  -- Validate device ownership when provided.
  IF v_device_id IS NOT NULL THEN
    PERFORM 1
    FROM public.user_devices d
    WHERE d.id = v_device_id
      AND d.organization_id = v_org
      AND d.user_id = v_user;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_location_ping_v1 device_id is not owned by current user' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Optional: derive run from stop, then branch from run (best-effort; avoids client hardcoding).
  IF v_stop_id IS NOT NULL THEN
    DECLARE
      v_stop_org UUID;
      v_stop_run UUID;
    BEGIN
      SELECT rs.organization_id, rs.route_run_id
        INTO v_stop_org, v_stop_run
        FROM public.route_stops rs
       WHERE rs.id = v_stop_id;

      IF v_stop_org IS NULL THEN
        RAISE EXCEPTION 'record_location_ping_v1 route_stop_id % not found', v_stop_id USING ERRCODE = '23503';
      END IF;
      IF v_stop_org IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'record_location_ping_v1: organization mismatch (ping org %, route_stop org %)', v_org, v_stop_org
          USING ERRCODE = '23514';
      END IF;

      IF v_run_id IS NULL THEN
        v_run_id := v_stop_run;
      ELSIF v_run_id IS DISTINCT FROM v_stop_run THEN
        RAISE EXCEPTION 'record_location_ping_v1: route_run_id mismatch vs route_stop' USING ERRCODE = '23514';
      END IF;
    END;
  END IF;

  IF v_run_id IS NOT NULL THEN
    PERFORM 1 FROM public.route_runs rr WHERE rr.id = v_run_id AND rr.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_location_ping_v1: route_run not found for org' USING ERRCODE = '23503';
    END IF;

    IF v_branch_id IS NULL THEN
      SELECT rr.branch_id INTO v_branch_id
      FROM public.route_runs rr
      WHERE rr.id = v_run_id AND rr.organization_id = v_org;
    END IF;
  END IF;

  IF v_branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches b WHERE b.id = v_branch_id AND b.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_location_ping_v1: branch not found for org' USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Resolve ingest/tracking policies (ladder-resolved; branch-aware via resource_id=branch_id when provided).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org,
    'user_id', v_user,
    'resource_id', v_branch_id,
    'event_type', 'location_ping'
  ));

  SELECT * INTO v_ingest FROM public.resolve_mobile_ingest_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_ingest.value IS NOT NULL THEN
    IF COALESCE((v_ingest.value->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_location_ping_v1 blocked by mobile_ingest_policy.enabled=false' USING ERRCODE = '42501';
    END IF;

    v_require_device := NULLIF(v_ingest.value->>'require_device', '')::boolean;
    IF COALESCE(v_require_device, FALSE) IS TRUE AND v_device_id IS NULL THEN
      RAISE EXCEPTION 'record_location_ping_v1 requires device_id by policy' USING ERRCODE = '42501';
    END IF;

    BEGIN v_max_payload := NULLIF(v_ingest.value->>'max_payload_bytes', '')::int; EXCEPTION WHEN others THEN v_max_payload := NULL; END;
    IF v_max_payload IS NOT NULL AND octet_length(v_in::text) > v_max_payload THEN
      RAISE EXCEPTION 'record_location_ping_v1 payload too large for policy' USING ERRCODE = '22001';
    END IF;

    v_allowed := v_ingest.value->'accepted_event_types';
    IF jsonb_typeof(v_allowed) = 'array' AND NOT (v_allowed ? 'location_ping') THEN
      RAISE EXCEPTION 'record_location_ping_v1 blocked by mobile_ingest_policy.accepted_event_types' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_track FROM public.resolve_location_tracking_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_track.value IS NOT NULL THEN
    IF COALESCE((v_track.value->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_location_ping_v1 blocked by location_tracking_policy.enabled=false' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Idempotency short-circuit.
  INSERT INTO public.location_ping_dedupe (organization_id, idempotency_key, location_ping_id, created_at)
  VALUES (v_org, v_idempotency, v_id, now())
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT d.location_ping_id INTO v_id
    FROM public.location_ping_dedupe d
    WHERE d.organization_id = v_org AND d.idempotency_key = v_idempotency
    LIMIT 1;
    RETURN QUERY SELECT v_id, FALSE;
    RETURN;
  END IF;

  INSERT INTO public.location_pings (
    id, organization_id, actor_user_id, device_id,
    route_run_id, route_stop_id, branch_id,
    coordinates, accuracy_m, speed_mps, heading_deg,
    idempotency_key, metadata,
    captured_at, received_at, created_at
  ) VALUES (
    v_id, v_org, v_user, v_device_id,
    v_run_id, v_stop_id, v_branch_id,
    ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography,
    v_accuracy, v_speed, v_heading,
    v_idempotency, v_meta,
    v_captured_at, now(), now()
  );

  RETURN QUERY SELECT v_id, v_created;
END;
$function$;

COMMENT ON FUNCTION public.record_location_ping_v1(JSONB)
  IS 'Insert a location ping (SSOT ledger) with idempotency via location_ping_dedupe; policy-resolved; tenant-only. Enforces RBAC tasks.complete permission.';

REVOKE ALL ON FUNCTION public.record_location_ping_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_location_ping_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_location_ping_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 3) record_scan_event_v1: require tasks.complete permission
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

  v_ops_session_id UUID := NULL;
  v_session_branch_id UUID := NULL;
  v_session_device_id UUID := NULL;
  v_session_actor UUID := NULL;
  v_session_org UUID := NULL;

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

  IF NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires tasks.complete permission' USING ERRCODE = '42501';
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
  BEGIN v_ops_session_id := NULLIF(btrim(COALESCE(v_in->>'ops_session_id', v_in->>'session_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_ops_session_id := NULL; END;

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

  -- Optional: ops session linking (org-safe; tenant callers can only link to their own sessions).
  IF v_ops_session_id IS NOT NULL THEN
    SELECT s.organization_id, s.branch_id, s.device_id, s.actor_user_id
      INTO v_session_org, v_session_branch_id, v_session_device_id, v_session_actor
      FROM public.ops_sessions s
     WHERE s.id = v_ops_session_id
     LIMIT 1;

    IF v_session_org IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1: ops_session_id % not found', v_ops_session_id USING ERRCODE = '23503';
    END IF;
    IF v_session_org IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'record_scan_event_v1: organization mismatch (event org %, ops_session org %)', v_org, v_session_org
        USING ERRCODE = '23514';
    END IF;
    IF NOT public.is_platform_user() AND v_session_actor IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'record_scan_event_v1: ops_session_id % not owned by current user', v_ops_session_id
        USING ERRCODE = '42501';
    END IF;

    IF v_branch_id IS NULL AND v_session_branch_id IS NOT NULL THEN
      v_branch_id := v_session_branch_id;
    ELSIF v_branch_id IS NOT NULL AND v_session_branch_id IS NOT NULL AND v_branch_id IS DISTINCT FROM v_session_branch_id THEN
      RAISE EXCEPTION 'record_scan_event_v1: branch mismatch vs ops_session (event branch %, session branch %)', v_branch_id, v_session_branch_id
        USING ERRCODE = '23514';
    END IF;

    IF v_device_id IS NULL AND v_session_device_id IS NOT NULL THEN
      v_device_id := v_session_device_id;
    ELSIF v_device_id IS NOT NULL AND v_session_device_id IS NOT NULL AND v_device_id IS DISTINCT FROM v_session_device_id THEN
      RAISE EXCEPTION 'record_scan_event_v1: device mismatch vs ops_session (event device %, session device %)', v_device_id, v_session_device_id
        USING ERRCODE = '23514';
    END IF;
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
    ops_session_id,
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
    v_ops_session_id,
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
  IS 'Insert a scan event (SSOT ledger) with idempotency via scan_event_dedupe; policy-resolved; tenant-only; can link scans to handling units, warehouse transfers, and ops sessions. Enforces RBAC tasks.complete permission.';

REVOKE ALL ON FUNCTION public.record_scan_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_scan_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_scan_event_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) open_ops_session_v1: require tasks.complete permission
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.open_ops_session_v1(
  p_input JSONB
)
RETURNS TABLE (
  ops_session_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_input, '{}'::jsonb);

  v_session_type TEXT := NULL;
  v_default_status TEXT := NULL;
  v_branch_id UUID := NULL;
  v_device_id UUID := NULL;
  v_session_code TEXT := NULL;
  v_idempotency TEXT := NULL;
  v_opened_at TIMESTAMPTZ := NULL;
  v_meta JSONB := '{}'::jsonb;

  v_id UUID := gen_random_uuid();
  v_existing_id UUID := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'open_ops_session_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  v_session_type := lower(NULLIF(btrim(COALESCE(v_in->>'session_type', '')), ''));
  v_idempotency := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_session_code := NULLIF(btrim(COALESCE(v_in->>'session_code', '')), '');

  BEGIN v_branch_id := NULLIF(btrim(COALESCE(v_in->>'branch_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_device_id := NULLIF(btrim(COALESCE(v_in->>'device_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_device_id := NULL; END;
  BEGIN v_opened_at := NULLIF(btrim(COALESCE(v_in->>'opened_at', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_opened_at := NULL; END;
  v_opened_at := COALESCE(v_opened_at, now());

  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN v_meta := '{}'::jsonb; END IF;

  IF v_session_type IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires session_type' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  -- Resolve default status via lookup (dynamic; no hardcoded enum values).
  SELECT lv.value
    INTO v_default_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'ops_session_status'
     AND lv.is_default IS TRUE
   ORDER BY lv.sort_order NULLS LAST, lv.value
   LIMIT 1;

  IF v_default_status IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 could not resolve default ops_session_status' USING ERRCODE = '23503';
  END IF;

  -- Validate session_type via lookup (dynamic; no hardcoded enum).
  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'ops_session_type'
    AND lv.value = v_session_type
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'open_ops_session_v1 invalid session_type: %', v_session_type USING ERRCODE = '23514';
  END IF;

  -- Create session projection (idempotent by org+idempotency_key).
  INSERT INTO public.ops_sessions (
    id,
    organization_id,
    session_type,
    status,
    branch_id,
    actor_user_id,
    device_id,
    session_code,
    idempotency_key,
    opened_at,
    closed_at,
    version,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_id,
    v_org,
    v_session_type,
    v_default_status,
    v_branch_id,
    v_user,
    v_device_id,
    v_session_code,
    v_idempotency,
    v_opened_at,
    NULL,
    1,
    v_meta,
    now(),
    now()
  )
  ON CONFLICT (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> ''
    DO NOTHING;

  IF FOUND THEN
    ops_session_id := v_id;
    created := TRUE;

    INSERT INTO public.ops_session_events (
      ops_session_id,
      organization_id,
      event_type,
      from_status,
      to_status,
      actor_user_id,
      actor_system,
      payload,
      idempotency_key,
      session_version,
      decision_log_id,
      settings_resolution_id,
      created_at
    )
    VALUES (
      ops_session_id,
      v_org,
      'opened',
      NULL,
      v_default_status,
      v_user,
      'open_ops_session_v1',
      jsonb_strip_nulls(jsonb_build_object(
        'session_type', v_session_type,
        'status', v_default_status,
        'branch_id', v_branch_id,
        'device_id', v_device_id,
        'session_code', v_session_code,
        'opened_at', v_opened_at
      )),
      v_idempotency,
      1,
      NULL,
      NULL,
      now()
    )
    ON CONFLICT DO NOTHING;
  ELSE
    SELECT s.id INTO v_existing_id
    FROM public.ops_sessions s
    WHERE s.organization_id = v_org
      AND s.idempotency_key = v_idempotency
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      RAISE EXCEPTION 'open_ops_session_v1 idempotency replay could not find session row' USING ERRCODE = '23503';
    END IF;

    ops_session_id := v_existing_id;
    created := FALSE;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'ops',
    p_resource_type := 'ops_session',
    p_resource_id := ops_session_id,
    p_decision_point := 'open',
    p_decision_outcome := CASE WHEN created IS TRUE THEN 'created' ELSE 'replayed' END,
    p_performed_by_system := 'open_ops_session_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'session_type', v_session_type,
      'branch_id', v_branch_id,
      'device_id', v_device_id,
      'session_code', v_session_code,
      'opened_at', v_opened_at,
      'idempotency_key', v_idempotency
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.open_ops_session_v1(JSONB)
  IS 'Create an ops session (projection + open event) idempotently by org+idempotency_key. Intended for driver/warehouse/branch sessionization. Enforces RBAC tasks.complete permission.';

REVOKE ALL ON FUNCTION public.open_ops_session_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_ops_session_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.open_ops_session_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) transition_ops_session_v1: require tasks.complete permission
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transition_ops_session_v1(
  p_input JSONB
)
RETURNS TABLE (
  ops_session_id UUID,
  updated BOOLEAN,
  status TEXT,
  closed_at TIMESTAMPTZ,
  session_version INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_input, '{}'::jsonb);

  v_session_id UUID := NULL;
  v_to_status TEXT := NULL;
  v_idempotency TEXT := NULL;
  v_effective_at TIMESTAMPTZ := NULL;
  v_set_closed BOOLEAN := FALSE;
  v_actor_system TEXT := NULL;
  v_payload JSONB := '{}'::jsonb;

  v_before public.ops_sessions%ROWTYPE;
  v_new_version INT := NULL;
  v_event_id UUID := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'transition_ops_session_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_session_id := NULLIF(btrim(COALESCE(v_in->>'ops_session_id', v_in->>'session_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_session_id := NULL; END;
  v_to_status := lower(NULLIF(btrim(COALESCE(v_in->>'to_status', '')), ''));
  v_idempotency := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_actor_system := NULLIF(btrim(COALESCE(v_in->>'actor_system', '')), '');
  v_payload := COALESCE(v_in->'payload', '{}'::jsonb);
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN v_payload := '{}'::jsonb; END IF;

  BEGIN v_effective_at := NULLIF(btrim(COALESCE(v_in->>'effective_at', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_effective_at := NULL; END;
  v_effective_at := COALESCE(v_effective_at, now());

  BEGIN v_set_closed := COALESCE((v_in->>'set_closed_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_closed := FALSE; END;

  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires ops_session_id' USING ERRCODE = '23514';
  END IF;
  IF v_to_status IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires to_status' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  -- Validate status via lookup (dynamic; no hardcoded enum).
  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'ops_session_status'
    AND lv.value = v_to_status
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_ops_session_v1 invalid to_status: %', v_to_status USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_before
  FROM public.ops_sessions s
  WHERE s.id = v_session_id
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_ops_session_v1 ops_session not found: %', v_session_id USING ERRCODE = '23503';
  END IF;

  IF v_before.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'transition_ops_session_v1: organization mismatch (session org %, actor org %)', v_before.organization_id, v_org
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.is_platform_user() AND v_before.actor_user_id IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'transition_ops_session_v1: actor_user mismatch (session actor %, current user %)', v_before.actor_user_id, v_user
      USING ERRCODE = '42501';
  END IF;

  -- Idempotency: replay existing event (no-op).
  PERFORM 1
  FROM public.ops_session_events e
  WHERE e.ops_session_id = v_session_id
    AND e.idempotency_key = v_idempotency
  LIMIT 1;
  IF FOUND THEN
    ops_session_id := v_before.id;
    status := v_before.status;
    closed_at := v_before.closed_at;
    session_version := v_before.version;
    updated := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  v_new_version := v_before.version + 1;

  UPDATE public.ops_sessions s
     SET status = v_to_status,
         closed_at = CASE WHEN v_set_closed IS TRUE THEN COALESCE(s.closed_at, v_effective_at) ELSE s.closed_at END,
         version = v_new_version,
         updated_at = now()
   WHERE s.id = v_session_id;

  INSERT INTO public.ops_session_events (
    ops_session_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    session_version,
    decision_log_id,
    settings_resolution_id,
    created_at
  )
  VALUES (
    v_session_id,
    v_org,
    'status_transition',
    v_before.status,
    v_to_status,
    v_user,
    COALESCE(v_actor_system, 'transition_ops_session_v1'),
    jsonb_strip_nulls(jsonb_build_object(
      'effective_at', v_effective_at,
      'set_closed_at', v_set_closed,
      'payload', v_payload
    )),
    v_idempotency,
    v_new_version,
    NULL,
    NULL,
    now()
  )
  RETURNING id INTO v_event_id;

  ops_session_id := v_session_id;
  status := v_to_status;
  closed_at := (SELECT s.closed_at FROM public.ops_sessions s WHERE s.id = v_session_id);
  session_version := v_new_version;
  updated := TRUE;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'ops',
    p_resource_type := 'ops_session',
    p_resource_id := v_session_id,
    p_decision_point := 'transition',
    p_decision_outcome := 'applied',
    p_performed_by_system := 'transition_ops_session_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'ops_session_id', v_session_id,
      'from_status', v_before.status,
      'to_status', v_to_status,
      'effective_at', v_effective_at,
      'set_closed_at', v_set_closed,
      'idempotency_key', v_idempotency,
      'event_id', v_event_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.transition_ops_session_v1(JSONB)
  IS 'Transition ops session status (ledgered). Idempotent by ops_session_id + idempotency_key; tenant actors can transition only their own sessions. Enforces RBAC tasks.complete permission.';

REVOKE ALL ON FUNCTION public.transition_ops_session_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_ops_session_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.transition_ops_session_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601300100_rbac_ops_sessions_mobile_ingest_guardrails_v1'));
COMMIT;
