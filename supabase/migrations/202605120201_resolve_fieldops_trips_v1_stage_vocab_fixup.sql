-- Migration: resolve_fieldops_trips_v1 stage vocabulary fixup
-- Date: 2026-05-12
-- Spec: Phase 6.F 2nd-pass audit P1 finding:
--   Previous fixup used `COALESCE(rr.metadata->>'stage', rr.status)` to
--   resolve trip stage. But `route_runs.status` uses run-status
--   vocabulary (`pending`, `in_progress`, `completed`, `cancelled`,
--   `closed`) which is not in the FE allow-list
--   `{assigned, gate-in, loading, sealed, in-transit, arrived,
--    gate-out, reconciled}`. The FE `parseTripList` therefore silently
--   downgraded every real row to "assigned".
--
-- Fix: SQL-level CASE mapping from rr.status to a valid trip stage
--   when `metadata.stage` is absent, so the FE allow-list always
--   matches what the RPC emits.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120201_resolve_fieldops_trips_v1_stage_vocab_fixup'));
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
        'id',              rr.id::text,
        'code',            'TRIP-' || substr(rr.id::text, 1, 8),
        'leg',             COALESCE(rr.metadata->>'leg', 'Hub → Hub'),
        'driver',          CASE WHEN rr.driver_user_id = v_user_id THEN 'You'
                                ELSE COALESCE(rr.metadata->>'driver_name', '—') END,
        'vehicle',         COALESCE(rr.metadata->>'vehicle', '—'),
        -- 2nd-pass audit fix: prefer explicit metadata.stage when present
        -- (already in FE allow-list); else map rr.status (run-status
        -- vocabulary) into the FE trip-stage allow-list. Unknown values
        -- safely fall to "assigned".
        'stage',           CASE
                             WHEN rr.metadata->>'stage' IN (
                               'assigned', 'gate-in', 'loading', 'sealed',
                               'in-transit', 'arrived', 'gate-out', 'reconciled'
                             ) THEN rr.metadata->>'stage'
                             WHEN rr.status = 'pending'      THEN 'assigned'
                             WHEN rr.status = 'in_progress'  THEN 'in-transit'
                             WHEN rr.status = 'completed'    THEN 'reconciled'
                             WHEN rr.status = 'closed'       THEN 'reconciled'
                             WHEN rr.status = 'cancelled'    THEN 'reconciled'
                             ELSE 'assigned'
                           END,
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
  'Mobile V2 line-haul trip aggregator (audit-hardened v2): full UUID id, decimal-tolerant numerics, stage mapped from rr.status into FE allow-list when metadata.stage absent.';

SELECT pg_advisory_unlock(hashtext('202605120201_resolve_fieldops_trips_v1_stage_vocab_fixup'));
COMMIT;
