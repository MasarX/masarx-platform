-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Location pings ledger v1 (partitioned + idempotent RPC)
-- Date: 2026-01-25
--
-- Goals:
--   - High-volume location telemetry SSOT for driver apps (live tracking + ETA).
--   - Partitioned + retention-governed (HASH+RANGE monthly).
--   - No direct DML from clients; writes via idempotent RPC with dedupe table.
--   - Policy-driven acceptance via ladder-resolved categories (no hardcoding).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251050_location_pings_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) location_pings ledger (HASH+RANGE monthly)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.location_pings (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  device_id UUID REFERENCES public.user_devices(id) ON DELETE SET NULL,
  route_run_id UUID REFERENCES public.route_runs(id) ON DELETE SET NULL,
  route_stop_id UUID REFERENCES public.route_stops(id) ON DELETE SET NULL,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,

  coordinates geography(POINT, 4326) NOT NULL,
  accuracy_m INT,
  speed_mps NUMERIC,
  heading_deg INT,

  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT location_pings_heading_ck CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360)),
  CONSTRAINT location_pings_accuracy_ck CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  CONSTRAINT location_pings_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> ''),

  PRIMARY KEY (id, organization_id, captured_at)
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS public.location_pings_p0
  PARTITION OF public.location_pings
  FOR VALUES WITH (MODULUS 1, REMAINDER 0)
  PARTITION BY RANGE (captured_at);

DO $$
DECLARE
  v_from DATE := date_trunc('month', now())::date;
  v_to   DATE := (date_trunc('month', now()) + INTERVAL '1 month')::date;
  v_name TEXT := format('location_pings_%s_%s_p0', EXTRACT(YEAR FROM v_from)::int, lpad(EXTRACT(MONTH FROM v_from)::int::text, 2, '0'));
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.location_pings_p0 FOR VALUES FROM (%L) TO (%L)',
      v_name,
      v_from::timestamptz,
      v_to::timestamptz
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_location_pings_actor_time
  ON public.location_pings (actor_user_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_location_pings_route_run_time
  ON public.location_pings (route_run_id, captured_at DESC)
  WHERE route_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_location_pings_route_stop_time
  ON public.location_pings (route_stop_id, captured_at DESC)
  WHERE route_stop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_location_pings_branch_time
  ON public.location_pings (branch_id, captured_at DESC)
  WHERE branch_id IS NOT NULL;

COMMENT ON TABLE public.location_pings IS
  'High-volume location telemetry ledger (SSOT) for live tracking/ETA. Partitioned and retention-governed; no direct DML from clients.';

-- Idempotency dedupe (separate for HASH+RANGE).
CREATE TABLE IF NOT EXISTS public.location_ping_dedupe (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  location_ping_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT location_ping_dedupe_key_nonempty CHECK (btrim(idempotency_key) <> ''),
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_location_ping_dedupe_ping
  ON public.location_ping_dedupe (location_ping_id);

COMMENT ON TABLE public.location_ping_dedupe IS
  'Idempotency keys for location_pings write-paths (unique per organization).';

-------------------------------------------------------------------------------
-- 2) RLS + least-privilege grants
-------------------------------------------------------------------------------

ALTER TABLE public.location_pings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_pings_p0 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_ping_dedupe ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.location_pings FROM PUBLIC;
REVOKE ALL ON TABLE public.location_pings FROM anon;
REVOKE ALL ON TABLE public.location_pings FROM authenticated;

REVOKE ALL ON TABLE public.location_pings_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.location_pings_p0 FROM anon;
REVOKE ALL ON TABLE public.location_pings_p0 FROM authenticated;

REVOKE ALL ON TABLE public.location_ping_dedupe FROM PUBLIC;
REVOKE ALL ON TABLE public.location_ping_dedupe FROM anon;
REVOKE ALL ON TABLE public.location_ping_dedupe FROM authenticated;

DROP POLICY IF EXISTS location_pings_select ON public.location_pings;
CREATE POLICY location_pings_select ON public.location_pings
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND actor_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS location_pings_service_policy ON public.location_pings;
CREATE POLICY location_pings_service_policy ON public.location_pings
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS location_pings_p0_service_policy ON public.location_pings_p0;
CREATE POLICY location_pings_p0_service_policy ON public.location_pings_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS location_ping_dedupe_service_policy ON public.location_ping_dedupe;
CREATE POLICY location_ping_dedupe_service_policy ON public.location_ping_dedupe
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.location_pings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.location_pings TO service_role;
GRANT ALL ON public.location_pings_p0 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.location_ping_dedupe TO service_role;

-------------------------------------------------------------------------------
-- 3) RPC: record_location_ping_v1 (idempotent; policy-driven)
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

  -- Resolve ingest/tracking policies (ladder-resolved; branch-aware via resource_id=branch_id when provided).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org,
    'resource_id', v_branch_id,
    'event_type', 'location_ping'
  ));

  SELECT * INTO v_ingest FROM public.resolve_mobile_ingest_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_ingest.value IS NOT NULL THEN
    IF COALESCE((v_ingest.value->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_location_ping_v1 blocked by mobile_ingest_policy.enabled=false' USING ERRCODE = '42501';
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
-- 4) Contracts + retention (partitioning_config)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'location_pings', TRUE, FALSE, FALSE, 'Telemetry ledger (immutable); audit disabled by contract.'),
  ('public', 'location_ping_dedupe', TRUE, FALSE, FALSE, 'Telemetry idempotency keys (service-only).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
)
VALUES (
  'location_pings',
  'HASH+RANGE',
  'organization_id|captured_at',
  'monthly',
  NULL,
  3,
  '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "purge"}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET
  partition_strategy = EXCLUDED.partition_strategy,
  partition_key = EXCLUDED.partition_key,
  partition_interval = EXCLUDED.partition_interval,
  partitions_ahead = EXCLUDED.partitions_ahead,
  retention_months = EXCLUDED.retention_months,
  config = EXCLUDED.config;

-- Bootstrap partitions now (idempotent; uses partitioning_config).
SELECT * FROM public.create_next_partitions();

SELECT pg_advisory_unlock(hashtext('202601251050_location_pings_v1'));
COMMIT;
