-- Migration: Map Al Izdihar canonical districts to Riyadh North zone
-- Purpose:
--   - Ensure short-code reverse geocoding can resolve a zone for Al Izdihar.
--   - Keep mapping row-driven and non-destructive (insert-only).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-11

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH target_zones AS (
  SELECT z.id AS zone_id, z.organization_id
  FROM public.zones z
  WHERE lower(z.name) = lower('Riyadh North')
    AND z.is_active = TRUE
),
target_districts AS (
  SELECT d.id AS canonical_district_id, d.organization_id
  FROM public.canonical_districts d
  JOIN public.canonical_cities c ON c.id = d.city_id
  WHERE d.is_active = TRUE
    AND lower(c.name_canonical) = lower('Riyadh')
    AND lower(d.name_canonical) IN (
      lower('Al Izdihar Dist.'),
      lower('Al Ezdihar Dist.')
    )
),
inserts AS (
  SELECT tz.zone_id, td.canonical_district_id
  FROM target_zones tz
  JOIN target_districts td
    ON td.organization_id = tz.organization_id
)
INSERT INTO public.zone_districts (zone_id, canonical_district_id)
SELECT i.zone_id, i.canonical_district_id
FROM inserts i
ON CONFLICT (canonical_district_id) DO NOTHING;

COMMIT;
