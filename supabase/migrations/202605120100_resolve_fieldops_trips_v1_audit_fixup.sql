-- Migration: resolve_fieldops_trips_v1 audit fixup
-- Date: 2026-05-12
-- Spec: Phase 6.F unbiased audit findings P0-5:
--   - Previous synthesis of trip id `'TRIP-' || substr(rr.id::text, 1, 8)`
--     truncates a UUID into 8 hex chars, which is unsafe at scale: two
--     route_runs whose UUIDs collide in the first 8 hex chars get the
--     same FE id, and `liveTrips.find(x => x.id === activeTripId)` picks
--     the wrong row.
--   - Previous `(metadata->>'distance_km')::int` throws when a tenant
--     writes a decimal value, so the whole trips RPC fails the whole tab.
--
-- Fix:
--   - Canonical id is now `rr.id::text` (full UUID). The synthesized
--     `TRIP-xxxxxxxx` label moves to a display-only `code` field that
--     the FE can render in the chrome hero. The FE Trip type already
--     accepts both: callers pass `id` for lookups and `leg` for the
--     visible label.
--   - Numeric coercions go through `::numeric` first then `::int`, with
--     COALESCE guards so a NULL or non-numeric value renders 0 instead
--     of throwing.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120100_resolve_fieldops_trips_v1_audit_fixup'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        -- Canonical id is the full UUID (audit P0-5: prevent
        -- substr-prefix collision at scale).
        'id',              rr.id::text,
        -- Optional human-readable code for chrome-hero display only.
        'code',            'TRIP-' || substr(rr.id::text, 1, 8),
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
        -- Decimal-tolerant integer coercion (audit P0-5: avoid throwing
        -- on '23.5'::int by going through ::numeric first).
        'etaMin',          COALESCE((rr.metadata->>'eta_min')::numeric, 0)::int,
        'distance',        COALESCE((rr.metadata->>'distance_km')::numeric, 0)::int,
        'totalParcels',    COALESCE((rr.metadata->>'total_parcels')::numeric, 0)::int,
        'scanned',         COALESCE((rr.metadata->>'scanned_parcels')::numeric, 0)::int,
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
  'Mobile V2 line-haul trip aggregator (audit-hardened): full UUID canonical id (no substr collision), decimal-tolerant numeric coercions. Returns route_runs scoped to caller org + driver/rider assignment, mapped to MobileV2Trip envelope.';

SELECT pg_advisory_unlock(hashtext('202605120100_resolve_fieldops_trips_v1_audit_fixup'));
COMMIT;
