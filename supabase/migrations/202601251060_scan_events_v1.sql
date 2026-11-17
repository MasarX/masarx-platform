-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Scan events ledger v1 (partitioned + idempotent RPC)
-- Date: 2026-01-25
--
-- Goals:
--   - High-volume scan events SSOT for warehouse + driver apps.
--   - Partitioned + retention-governed (HASH+RANGE monthly).
--   - No direct DML from clients; writes via idempotent RPC with dedupe table.
--   - Policy-driven acceptance via ladder-resolved categories (no hardcoding).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251060_scan_events_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds (dynamic enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('scan_type', 'Warehouse/driver scan types (pickup/sort/load/unload/delivery_attempt/delivered/etc.)', 'ops', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pickup', 'Pickup', 'Picked up (from sender/client)', 10, FALSE, '{}' ),
  ('sort', 'Sort', 'Sorted in facility', 20, FALSE, '{}' ),
  ('load', 'Load', 'Loaded onto vehicle/route', 30, FALSE, '{}' ),
  ('unload', 'Unload', 'Unloaded from vehicle/route', 40, FALSE, '{}' ),
  ('delivery_attempt', 'Delivery Attempt', 'Delivery attempt scan', 50, FALSE, '{}' ),
  ('delivered', 'Delivered', 'Delivered scan', 60, TRUE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'scan_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) scan_events ledger (HASH+RANGE monthly)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scan_events (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  device_id UUID REFERENCES public.user_devices(id) ON DELETE SET NULL,

  route_run_id UUID REFERENCES public.route_runs(id) ON DELETE SET NULL,
  route_stop_id UUID REFERENCES public.route_stops(id) ON DELETE SET NULL,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,

  -- Shipments are HASH partitioned by client_id; store client_id alongside shipment_id for deterministic joins.
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  shipment_id UUID,

  artifact_id UUID REFERENCES public.artifacts(id) ON DELETE SET NULL,

  scan_type TEXT NOT NULL, -- lookup category: scan_type
  barcode TEXT NOT NULL,

  coordinates geography(POINT, 4326),
  accuracy_m INT,

  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT scan_events_scan_type_ck CHECK (btrim(scan_type) <> '' AND scan_type = lower(scan_type)),
  CONSTRAINT scan_events_barcode_ck CHECK (btrim(barcode) <> ''),
  CONSTRAINT scan_events_accuracy_ck CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  CONSTRAINT scan_events_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> ''),
  CONSTRAINT scan_events_shipment_pair_ck CHECK (
    (shipment_id IS NULL AND client_id IS NULL)
    OR (shipment_id IS NOT NULL AND client_id IS NOT NULL)
  ),
  CONSTRAINT scan_events_shipment_fk
    FOREIGN KEY (shipment_id, client_id) REFERENCES public.shipments(id, client_id) ON DELETE SET NULL,

  PRIMARY KEY (id, organization_id, captured_at)
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS public.scan_events_p0
  PARTITION OF public.scan_events
  FOR VALUES WITH (MODULUS 1, REMAINDER 0)
  PARTITION BY RANGE (captured_at);

DO $$
DECLARE
  v_from DATE := date_trunc('month', now())::date;
  v_to   DATE := (date_trunc('month', now()) + INTERVAL '1 month')::date;
  v_name TEXT := format('scan_events_%s_%s_p0', EXTRACT(YEAR FROM v_from)::int, lpad(EXTRACT(MONTH FROM v_from)::int::text, 2, '0'));
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.scan_events_p0 FOR VALUES FROM (%L) TO (%L)',
      v_name,
      v_from::timestamptz,
      v_to::timestamptz
    );
  END IF;

  -- Lock down the first leaf to match the global partition security posture (no anon/auth grants).
  PERFORM public.enforce_service_only_rls_v1(('public.' || v_name)::regclass);
END $$;

CREATE INDEX IF NOT EXISTS idx_scan_events_actor_time
  ON public.scan_events (actor_user_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_barcode_time
  ON public.scan_events (barcode, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_route_run_time
  ON public.scan_events (route_run_id, captured_at DESC)
  WHERE route_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scan_events_route_stop_time
  ON public.scan_events (route_stop_id, captured_at DESC)
  WHERE route_stop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scan_events_branch_time
  ON public.scan_events (branch_id, captured_at DESC)
  WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scan_events_client_shipment_time
  ON public.scan_events (client_id, shipment_id, captured_at DESC)
  WHERE client_id IS NOT NULL AND shipment_id IS NOT NULL;

COMMENT ON TABLE public.scan_events IS
  'High-volume scan events ledger (SSOT) for warehouse/driver scan points. Partitioned and retention-governed; no direct DML from clients.';

-- Idempotency dedupe (separate for HASH+RANGE).
CREATE TABLE IF NOT EXISTS public.scan_event_dedupe (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  scan_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scan_event_dedupe_key_nonempty CHECK (btrim(idempotency_key) <> ''),
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_scan_event_dedupe_event
  ON public.scan_event_dedupe (scan_event_id);

COMMENT ON TABLE public.scan_event_dedupe IS
  'Idempotency keys for scan_events write-paths (unique per organization).';

-------------------------------------------------------------------------------
-- 3) RLS + least-privilege grants
-------------------------------------------------------------------------------

ALTER TABLE public.scan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_events_p0 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_event_dedupe ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.scan_events FROM PUBLIC;
REVOKE ALL ON TABLE public.scan_events FROM anon;
REVOKE ALL ON TABLE public.scan_events FROM authenticated;

REVOKE ALL ON TABLE public.scan_events_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.scan_events_p0 FROM anon;
REVOKE ALL ON TABLE public.scan_events_p0 FROM authenticated;

REVOKE ALL ON TABLE public.scan_event_dedupe FROM PUBLIC;
REVOKE ALL ON TABLE public.scan_event_dedupe FROM anon;
REVOKE ALL ON TABLE public.scan_event_dedupe FROM authenticated;

DROP POLICY IF EXISTS scan_events_select ON public.scan_events;
CREATE POLICY scan_events_select ON public.scan_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND actor_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS scan_events_service_policy ON public.scan_events;
CREATE POLICY scan_events_service_policy ON public.scan_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS scan_events_p0_service_policy ON public.scan_events_p0;
CREATE POLICY scan_events_p0_service_policy ON public.scan_events_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS scan_event_dedupe_service_policy ON public.scan_event_dedupe;
CREATE POLICY scan_event_dedupe_service_policy ON public.scan_event_dedupe
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.scan_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scan_events TO service_role;
GRANT ALL ON public.scan_events_p0 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scan_event_dedupe TO service_role;

-------------------------------------------------------------------------------
-- 4) RPC: record_scan_event_v1 (idempotent; policy-driven)
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

  v_device_id UUID := NULL;
  v_run_id UUID := NULL;
  v_stop_id UUID := NULL;
  v_branch_id UUID := NULL;

  v_client_id UUID := NULL;
  v_shipment_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_artifact_id UUID := NULL;

  v_scan_type TEXT := NULL;
  v_barcode TEXT := NULL;
  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_meta JSONB := '{}'::jsonb;

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
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 could not resolve organization_id';
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'record_scan_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  v_scan_type := lower(NULLIF(btrim(COALESCE(v_in->>'scan_type', '')), ''));
  v_barcode := NULLIF(btrim(COALESCE(v_in->>'barcode', '')), '');

  IF v_scan_type IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires scan_type' USING ERRCODE = '23514';
  END IF;
  IF v_barcode IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires barcode' USING ERRCODE = '23514';
  END IF;

  BEGIN v_device_id := NULLIF(v_in->>'device_id', '')::uuid; EXCEPTION WHEN others THEN v_device_id := NULL; END;
  BEGIN v_run_id := NULLIF(v_in->>'route_run_id', '')::uuid; EXCEPTION WHEN others THEN v_run_id := NULL; END;
  BEGIN v_stop_id := NULLIF(v_in->>'route_stop_id', '')::uuid; EXCEPTION WHEN others THEN v_stop_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_in->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;

  BEGIN v_client_id := NULLIF(v_in->>'client_id', '')::uuid; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_shipment_id := NULLIF(v_in->>'shipment_id', '')::uuid; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_artifact_id := NULLIF(v_in->>'artifact_id', '')::uuid; EXCEPTION WHEN others THEN v_artifact_id := NULL; END;

  BEGIN v_lat := NULLIF(v_in->>'lat', '')::double precision; EXCEPTION WHEN others THEN v_lat := NULL; END;
  BEGIN v_lng := NULLIF(v_in->>'lng', '')::double precision; EXCEPTION WHEN others THEN v_lng := NULL; END;
  BEGIN v_accuracy := NULLIF(v_in->>'accuracy_m', '')::int; EXCEPTION WHEN others THEN v_accuracy := NULL; END;
  BEGIN v_captured_at := NULLIF(v_in->>'captured_at', '')::timestamptz; EXCEPTION WHEN others THEN v_captured_at := NULL; END;

  IF (v_lat IS NULL) IS DISTINCT FROM (v_lng IS NULL) THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires both lat and lng when providing coordinates' USING ERRCODE = '23514';
  END IF;

  IF v_captured_at IS NULL THEN
    v_captured_at := now();
  END IF;

  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) <> 'object' THEN v_meta := '{}'::jsonb; END IF;

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
    SELECT s.sender_id INTO v_sender_id
    FROM public.shipments s
    WHERE s.id = v_shipment_id
      AND s.client_id = v_client_id
      AND s.organization_id = v_org;
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
    client_id, shipment_id, artifact_id,
    scan_type, barcode,
    coordinates, accuracy_m,
    idempotency_key, metadata,
    captured_at, received_at, created_at
  ) VALUES (
    v_id, v_org, v_user, v_device_id,
    v_run_id, v_stop_id, v_branch_id,
    v_client_id, v_shipment_id, v_artifact_id,
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
  IS 'Insert a scan event (SSOT ledger) with idempotency via scan_event_dedupe; policy-resolved; intended for driver/warehouse device ingest.';
REVOKE ALL ON FUNCTION public.record_scan_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_scan_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_scan_event_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) Contracts + retention (partitioning_config)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'scan_events', TRUE, FALSE, FALSE, 'Scan events ledger (immutable); audit disabled by contract.'),
  ('public', 'scan_event_dedupe', TRUE, FALSE, FALSE, 'Scan event idempotency keys (service-only).')
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
  'scan_events',
  'HASH+RANGE',
  'organization_id|captured_at',
  'monthly',
  NULL,
  12,
  '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "delete"}'::jsonb
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

SELECT pg_advisory_unlock(hashtext('202601251060_scan_events_v1'));
COMMIT;
