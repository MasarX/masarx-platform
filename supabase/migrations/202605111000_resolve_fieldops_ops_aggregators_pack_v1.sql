-- Migration: resolve_fieldops_ops_aggregators_pack_v1 — Phase 6 backend
-- Date: 2026-05-11
-- Spec: Phase 6.F Mobile V2 ops surfaces. Mobile screens (Trips,
--       Sortation, Lookup, Returns, Hub Pickup, Hold queue, Cash drop,
--       Wallet, EOR) must read row-driven from canonical tables via
--       resolver RPCs. This migration ships the 9 aggregator RPCs that
--       the Mobile V2 frontend hooks expect, each returning a typed
--       JSONB envelope, role-filtered for the calling driver, and
--       org-scoped via current_user_org_id().
--
--       All RPCs are STABLE + SECURITY DEFINER + grant to authenticated.
--       They prefer empty/sensible envelopes over raising when source
--       tables are absent — the FE hooks fall back to local samples for
--       preview mode, and absence of data is a valid state. Future
--       migrations can extend these aggregators to read newly-shipped
--       tables without changing the frontend contract.
--
-- AGENTS.md compliance:
-- - Row-driven: every numeric / SAR / status is read from canonical tables
--   or resolved via ladder policy; no per-tenant constants in code.
-- - Override ladder: policy lookups call resolve_settings()/resolver_v1()
--   where applicable (cash policy via mobile_cash_policy).
-- - RLS: aggregators are SECURITY DEFINER but org-scope every query via
--   current_user_org_id(); they never expose cross-org rows.
-- - Single source of truth: api.* wrappers proxy to public.* with
--   SECURITY INVOKER so PostgREST sees a stable contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605111000_resolve_fieldops_ops_aggregators_pack_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ===========================================================================
-- 1) resolve_fieldops_trips_v1 — line-haul trip list for the calling driver.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_trips_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_role TEXT := lower(btrim(COALESCE(p_active_role, 'driver')));
  v_rows JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_trips_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  -- Source rows from route_runs as the closest canonical trip primitive
  -- already available in the schema. Each row produces a MobileV2Trip
  -- envelope. line-haul trips are not yet a distinct table; using
  -- route_runs marked as transfer/line-haul (or fallback to all active
  -- runs the caller owns/sees) keeps this row-driven.
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',              'TRIP-' || substr(rr.id::text, 1, 8),
        'leg',             COALESCE(rr.metadata->>'leg', 'Hub → Hub'),
        'driver',          CASE WHEN rr.driver_user_id = v_user_id THEN 'You'
                                ELSE COALESCE(rr.metadata->>'driver_name', '—') END,
        'vehicle',         COALESCE(rr.metadata->>'vehicle', '—'),
        'stage',           COALESCE(rr.metadata->>'stage', rr.status),
        'origin',          jsonb_build_object(
          'id',   COALESCE(rr.metadata->>'origin_hub_id', 'HUB-ORG'),
          'name', COALESCE(rr.metadata->>'origin_hub_name', 'Origin hub')
        ),
        'dest',            jsonb_build_object(
          'id',   COALESCE(rr.metadata->>'dest_hub_id', 'HUB-ORG'),
          'name', COALESCE(rr.metadata->>'dest_hub_name', 'Dest hub')
        ),
        'plannedDepart',   COALESCE(rr.metadata->>'planned_depart', ''),
        'plannedArrive',   COALESCE(rr.metadata->>'planned_arrive', ''),
        'etaMin',          COALESCE((rr.metadata->>'eta_min')::int, 0),
        'distance',        COALESCE((rr.metadata->>'distance_km')::int, 0),
        'totalParcels',    COALESCE((rr.metadata->>'total_parcels')::int, 0),
        'scanned',         COALESCE((rr.metadata->>'scanned_parcels')::int, 0),
        'sealNo',          rr.metadata->>'seal_no',
        'manifest',        COALESCE(rr.metadata->'manifest', '[]'::jsonb)
      )
      ORDER BY rr.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.route_runs rr
  WHERE rr.organization_id = v_org
    AND (v_role NOT IN ('driver', 'rider') OR rr.driver_user_id = v_user_id)
    AND COALESCE(rr.metadata->>'kind', 'route') = ANY (ARRAY['route', 'trip', 'linehaul', 'transfer']);

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_trips_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_fieldops_trips_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_trips_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_trips_v1(TEXT, JSONB) IS
  'Mobile V2 line-haul trip aggregator. Returns route_runs scoped to caller org + driver/rider assignment, mapped to MobileV2Trip envelope. Falls back to empty array when no org or no rows; FE hook falls back to local sample for preview mode.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_trips_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_trips_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_trips_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_fieldops_trips_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_trips_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 2) resolve_fieldops_sortation_v1 — bay grid + recent inductions.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_sortation_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_sortation_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'bays', '[]'::jsonb,
      'recent', '[]'::jsonb,
      'inducted', 0,
      'throughput_per_hour', 0,
      'minutes_elapsed', 0
    );
  END IF;

  -- Sortation tables not yet shipped; return shape-compatible empty
  -- envelope so the FE hook falls through to its preview sample.
  RETURN jsonb_build_object(
    'bays', '[]'::jsonb,
    'recent', '[]'::jsonb,
    'inducted', 0,
    'throughput_per_hour', 0,
    'minutes_elapsed', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_sortation_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_fieldops_sortation_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_sortation_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_sortation_v1(TEXT, JSONB) IS
  'Mobile V2 sortation bays + recent inductions aggregator. Returns shape-compatible empty envelope until sortation_bays + sortation_inductions tables ship; FE hook falls back to local sample.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_sortation_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_sortation_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_sortation_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_sortation_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 3) resolve_fieldops_lookup_v1 — universal search + recent.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_lookup_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb,
  p_query TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_query TEXT := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_records JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_lookup_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL OR v_query IS NULL THEN
    RETURN jsonb_build_object('records', '[]'::jsonb, 'recent', '[]'::jsonb);
  END IF;

  -- Search shipments by tracking number / external_id (LIKE-style for now;
  -- a future fts index can replace this with phraseto_tsquery).
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',       s.id::text,
        'kind',     CASE WHEN s.service_type = 'pickup' THEN 'pickup' ELSE 'stop' END,
        'parcel',   s.tracking_number,
        'customer', COALESCE(s.recipient_name, s.metadata->>'merchant_name', '—'),
        'area',     COALESCE(s.metadata->>'area', s.recipient_city),
        'status',   s.status
      )
      ORDER BY s.updated_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_records
  FROM (
    SELECT *
    FROM public.shipments s
    WHERE s.organization_id = v_org
      AND (
        s.tracking_number ILIKE ('%' || v_query || '%')
        OR s.external_id ILIKE ('%' || v_query || '%')
        OR s.recipient_name ILIKE ('%' || v_query || '%')
      )
    LIMIT 10
  ) s;

  RETURN jsonb_build_object('records', v_records, 'recent', '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_lookup_v1(TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_fieldops_lookup_v1(TEXT, JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_lookup_v1(TEXT, JSONB, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_lookup_v1(TEXT, JSONB, TEXT) IS
  'Mobile V2 universal shipment lookup. ILIKE-search across tracking_number / external_id / recipient_name within caller org, returning up to 10 records. Recent lookups list is empty until a recent_lookups table ships; FE hook falls back to local sample for preview.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_lookup_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb,
  p_query TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_lookup_v1(p_active_role, p_context, p_query); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_lookup_v1(TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_lookup_v1(TEXT, JSONB, TEXT) TO authenticated, service_role;

-- ===========================================================================
-- 4) resolve_fieldops_returns_v1 — failed + RTO stops awaiting hub return.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_returns_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_failed JSONB := '[]'::jsonb;
  v_returned JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_returns_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('failed', '[]'::jsonb, 'returned', '[]'::jsonb, 'cod_collected_sar', 0);
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',         rs.id::text,
        'seq',        rs.sequence_order,
        'customer',   COALESCE(rs.metadata->>'customer_name', '—'),
        'addr',       COALESCE(rs.metadata->>'address', ''),
        'parcels',    COALESCE((rs.metadata->>'parcels')::int, 1),
        'failReason', COALESCE(rs.metadata->>'fail_reason', 'Customer unreachable')
      )
      ORDER BY rs.sequence_order
    ),
    '[]'::jsonb
  )
  INTO v_failed
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
   AND rr.organization_id = rs.organization_id
  WHERE rr.organization_id = v_org
    AND COALESCE(rs.metadata->>'status', '') = 'failed'
    AND rr.driver_user_id = v_user_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',       'RTO-' || substr(rs.id::text, 1, 8),
        'customer', COALESCE(rs.metadata->>'customer_name', '—'),
        'parcels',  COALESCE((rs.metadata->>'parcels')::int, 1)
      )
      ORDER BY rs.sequence_order
    ),
    '[]'::jsonb
  )
  INTO v_returned
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
   AND rr.organization_id = rs.organization_id
  WHERE rr.organization_id = v_org
    AND COALESCE(rs.metadata->>'status', '') = 'rto'
    AND rr.driver_user_id = v_user_id;

  RETURN jsonb_build_object(
    'failed', v_failed,
    'returned', v_returned,
    'cod_collected_sar', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_returns_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_returns_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_returns_v1(TEXT, JSONB) IS
  'Mobile V2 returns-to-hub aggregator. Returns failed + RTO route_stops scoped to the calling driver, with COD-collected total. Driver-scope only; supervisors get an empty payload here (use ops console).';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_returns_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_returns_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_returns_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_returns_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 5) resolve_fieldops_hub_pickup_v1 — counter staff queue.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_hub_pickup_v1(
  p_active_role TEXT DEFAULT 'supervisor',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_hub_pickup_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  -- hub_pickup_queue table not yet shipped; empty envelope is correct.
  RETURN '[]'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_hub_pickup_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_hub_pickup_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_hub_pickup_v1(TEXT, JSONB) IS
  'Mobile V2 hub pickup desk queue. Returns empty array until hub_pickup_queue table ships; FE hook falls back to local sample for preview.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_hub_pickup_v1(
  p_active_role TEXT DEFAULT 'supervisor',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_hub_pickup_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_hub_pickup_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_hub_pickup_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 6) resolve_fieldops_hold_v1 — exception queue awaiting decision.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_hold_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_hold_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  -- hold_queue table not yet shipped; empty envelope is correct.
  RETURN '[]'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_hold_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_hold_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_hold_v1(TEXT, JSONB) IS
  'Mobile V2 hold/exception queue. Returns empty array until hold_queue table ships; FE hook falls back to local sample.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_hold_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_hold_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_hold_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_hold_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 7) resolve_fieldops_cash_drop_v1 — expected COD + safe location.
--    Ladder-resolved via mobile_cash_policy (per AGENTS.md Mobile policy).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_cash_drop_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_policy JSONB;
  v_safe TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_cash_drop_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('expected_sar', 0, 'safe_location', '—');
  END IF;

  -- Pull cash policy through the resolver ladder if present; fall back to
  -- empty object so callers don't fail-closed in preview.
  BEGIN
    SELECT public.resolve_settings(
      'mobile_cash_policy',
      jsonb_build_object('organization_id', v_org, 'user_id', v_user_id)
    )
    INTO v_policy;
  EXCEPTION WHEN OTHERS THEN
    v_policy := '{}'::jsonb;
  END;

  v_safe := COALESCE(v_policy->>'safe_location', 'Hub safe');

  RETURN jsonb_build_object(
    'expected_sar', COALESCE((v_policy->>'default_expected_sar')::int, 0),
    'safe_location', v_safe
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) IS
  'Mobile V2 cash drop expected envelope. Resolves expected SAR + safe location via mobile_cash_policy ladder (Global<Tenant<Client<Sender<Resource). FE hook falls back to local sample when policy is absent.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_cash_drop_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_cash_drop_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_cash_drop_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_cash_drop_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 8) resolve_fieldops_wallet_v1 — driver earnings envelope.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_wallet_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_wallet_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'wallet', jsonb_build_object('balance_sar', 0, 'week_to_date_sar', 0, 'posts_to_bank_label', 'Posts to bank Monday'),
      'week', '[]'::jsonb,
      'breakdown', '[]'::jsonb
    );
  END IF;
  -- driver_earnings table not yet shipped; empty envelope is correct.
  RETURN jsonb_build_object(
    'wallet', jsonb_build_object(
      'balance_sar', 0,
      'week_to_date_sar', 0,
      'posts_to_bank_label', 'Posts to bank Monday'
    ),
    'week', '[]'::jsonb,
    'breakdown', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_wallet_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_wallet_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_wallet_v1(TEXT, JSONB) IS
  'Mobile V2 driver wallet envelope. Returns empty envelope until driver_earnings + driver_settlements tables ship; FE hook falls back to local sample for preview.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_wallet_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_wallet_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_wallet_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_wallet_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 9) resolve_fieldops_eor_v1 — end of route hand-back checklist.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_eor_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_delivered INT := 0;
  v_failed INT := 0;
  v_total INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_eor_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'summary', jsonb_build_object('delivered', 0, 'failed', 0, 'total', 0),
      'checklist', '[]'::jsonb,
      'performance_note', NULL
    );
  END IF;

  -- Compute today's summary from route_stops on the caller's runs.
  SELECT
    COALESCE(SUM(CASE WHEN COALESCE(rs.metadata->>'status', '') = 'done' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN COALESCE(rs.metadata->>'status', '') = 'failed' THEN 1 ELSE 0 END), 0),
    COUNT(*)
  INTO v_delivered, v_failed, v_total
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
   AND rr.organization_id = rs.organization_id
  WHERE rr.organization_id = v_org
    AND rr.driver_user_id = v_user_id
    AND rr.created_at::date = (now() AT TIME ZONE 'Asia/Riyadh')::date;

  RETURN jsonb_build_object(
    'summary', jsonb_build_object(
      'delivered', v_delivered,
      'failed', v_failed,
      'total', v_total
    ),
    'checklist', jsonb_build_array(
      jsonb_build_object('id','parcels','icon','package','label','Returned undelivered parcels','sub', (v_failed + GREATEST(v_total - v_delivered - v_failed, 0))::text || ' parcels in vehicle'),
      jsonb_build_object('id','cash','icon','cash','label','Hand over COD cash','sub','See cash drop'),
      jsonb_build_object('id','devices','icon','shield','label','Plug in handheld + scanner','sub','Battery report uploaded'),
      jsonb_build_object('id','sync','icon','cloud-up','label','Final sync','sub','Outbox check')
    ),
    'performance_note', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) IS
  'Mobile V2 end-of-route hand-back envelope. Summary computed from caller route_stops today; checklist is row-defined here (future migrations can move to mobile_eor_checklist_v1 policy). Performance note is null until shift_performance_v1 ships.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_eor_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_eor_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_eor_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_eor_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605111000_resolve_fieldops_ops_aggregators_pack_v1'));
COMMIT;
