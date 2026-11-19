-- Migration: api.ui_geocodes_with_latlng_v1 — geocodes projection with lat/lng scalars
-- Spec-Issue: Wave 6 W6-5 (schema-drift OPERATIONS §15)
-- Step: E01
--
-- Purpose:
--   The FE `GeocodeRow` interface (apps/console-v2/src/modules/operate/tracking-map.tsx)
--   exposes `latitude` and `longitude` as scalar number fields. The canonical
--   `public.geocodes` table stores location as `coordinates geography(POINT, 4326)`
--   — a single PostGIS point. Without a projection RPC, the FE can either:
--     (a) consume `coordinates` as a GeoJSON object (FE shape change), or
--     (b) read scalar lat/lng from a server-side projection (this migration).
--
--   This migration adds option (b): a thin SECURITY INVOKER read RPC that
--   re-projects `coordinates` into `latitude` / `longitude` using `ST_Y(...)` and
--   `ST_X(...)`. RLS on `public.geocodes` continues to apply (SECURITY INVOKER).
--
--   Audit cite: __audit__/SCHEMA-DRIFT/OPERATIONS.md §15 (cross-cutting note —
--   "ui_read_registry.geocodes projection must expand the geography point into
--   lat/lng pair").
--
-- Contract:
--   - SECURITY INVOKER: caller's RLS policies + capability gating apply.
--   - Returns the canonical row plus two derived numeric columns.
--   - No mutation; no decision_log writes; no privileged side effects.
--
-- Compatibility:
--   - Pure additive RPC; existing callers of `geocodes` remain valid.
--   - Caller can filter by `address_id` via SQL `WHERE` on the returned set,
--     or pass a focused `p_address_id` to leverage the partition pruning index.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301100_ui_geocodes_with_latlng_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- API schema gate: api.* must exist (created by earlier migrations).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'api') THEN
    RAISE EXCEPTION 'api schema is missing; bootstrap migrations expected to create it before %', '202604301100';
  END IF;
END
$$;

-- ============================================================================
-- RPC: api.ui_geocodes_with_latlng_v1(p_address_id uuid)
-- ============================================================================
CREATE OR REPLACE FUNCTION api.ui_geocodes_with_latlng_v1(p_address_id UUID DEFAULT NULL)
RETURNS TABLE (
  id                  UUID,
  address_id          UUID,
  provider_name       TEXT,
  latitude            DOUBLE PRECISION,
  longitude           DOUBLE PRECISION,
  confidence_score    NUMERIC,
  accuracy_type       TEXT,
  formatted_address   TEXT,
  metadata            JSONB,
  is_primary          BOOLEAN,
  geocoded_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ
)
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT
    g.id,
    g.address_id,
    g.provider_name,
    -- ST_Y returns latitude (y-axis); ST_X returns longitude (x-axis).
    ST_Y(g.coordinates::geometry)::DOUBLE PRECISION  AS latitude,
    ST_X(g.coordinates::geometry)::DOUBLE PRECISION  AS longitude,
    g.confidence_score,
    g.accuracy_type,
    g.formatted_address,
    g.metadata,
    g.is_primary,
    g.geocoded_at,
    g.expires_at
    FROM public.geocodes g
   WHERE p_address_id IS NULL
      OR g.address_id = p_address_id;
$$;

COMMENT ON FUNCTION api.ui_geocodes_with_latlng_v1(UUID) IS
  'Read-only projection over public.geocodes that exposes the geography(POINT,4326) coordinates as lat/lng scalars. SECURITY INVOKER — caller RLS applies. See __audit__/SCHEMA-DRIFT/OPERATIONS.md §15.';

-- Grant execute to PostgREST roles (RLS still enforced via SECURITY INVOKER).
GRANT EXECUTE ON FUNCTION api.ui_geocodes_with_latlng_v1(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_geocodes_with_latlng_v1(UUID) TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301100_ui_geocodes_with_latlng_v1'));
COMMIT;
