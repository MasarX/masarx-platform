-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Location pings hardening v1 (policy enforcement + partition security + retention)
-- Date: 2026-01-25
--
-- Goals:
--   - Enforce mobile_ingest_policy contract consistently for location pings (require_device, max payload, accepted types).
--   - Harden cross-tenant integrity for optional route/branch links (best-effort guardrails).
--   - Lock down existing leaf partitions to match global partition security posture (no anon/auth grants).
--   - Align retention_policy with supported archiving behavior (delete/archive only).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251065_location_pings_hardening_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) RPC hardening: record_location_ping_v1 (policy enforcement + integrity)
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
  IS 'Insert a location ping (SSOT ledger) with idempotency via location_ping_dedupe; policy-resolved; intended for driver device ingest.';
REVOKE ALL ON FUNCTION public.record_location_ping_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_location_ping_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_location_ping_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Partition security posture: lock down existing location_pings leaves
-------------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT partition_name
    FROM public.partition_inventory
    WHERE table_name = 'location_pings'
      AND partition_name IS NOT NULL
  LOOP
    PERFORM public.enforce_service_only_rls_v1(('public.' || r.partition_name)::regclass);
  END LOOP;
END $$;

-------------------------------------------------------------------------------
-- 3) Retention policy alignment (archive_old_partitions supports archive/delete)
-------------------------------------------------------------------------------

UPDATE public.partitioning_config
SET
  config = jsonb_set(COALESCE(config, '{}'::jsonb), '{retention_policy}', '"delete"', TRUE),
  updated_at = now()
WHERE table_name = 'location_pings';

-- Ensure future partitions exist (idempotent) and are locked down on creation.
SELECT * FROM public.create_next_partitions();

SELECT pg_advisory_unlock(hashtext('202601251065_location_pings_hardening_v1'));
COMMIT;
