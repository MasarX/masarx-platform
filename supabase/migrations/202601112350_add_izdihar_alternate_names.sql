-- Migration: Add Al Izdihar alternate names to Al Ezdihar canonical district
-- Purpose:
--   - Normalize transliteration variants so short-code reverse geocode can resolve canonical district.
--   - Preserve row-driven matching via alternate_names (no code changes).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-11

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.canonical_districts d
SET alternate_names = (
  SELECT ARRAY(
    SELECT DISTINCT val
    FROM (
      SELECT unnest(COALESCE(d.alternate_names, ARRAY[]::text[])) AS val
      UNION ALL
      SELECT 'Al Izdihar Dist.'
      UNION ALL
      SELECT 'Al Izdihar'
    ) merged
  )
)
FROM public.canonical_cities c
WHERE c.id = d.city_id
  AND lower(c.name_canonical) = lower('Riyadh')
  AND lower(d.name_canonical) = lower('Al Ezdihar Dist.');

COMMIT;
