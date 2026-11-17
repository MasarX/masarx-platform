-- Migration: Seed benchmark geocoding samples (minimal corpus)
-- Purpose: Ensure benchmark table has labeled rows for plugin accuracy/timing tests.

BEGIN;

-- Perfect clean address
INSERT INTO benchmark_geocoding_samples (
  category, language, line1, city, district, province, country,
  expected_city_id, expected_district_id, expected_plugin, expected_outcome
)
SELECT
  'perfect', 'en', 'Olaya St 12', 'Riyadh', 'Al Amal', 'Riyadh', 'SA',
  rc.id, da.id, 'perfect', 'should_match'
FROM (
  SELECT id FROM canonical_cities WHERE lower(name_canonical) LIKE lower('Riyadh%') LIMIT 1
) rc,
(
  SELECT id FROM canonical_districts WHERE lower(name_canonical) LIKE lower('Al Amal%') LIMIT 1
) da
ON CONFLICT (id) DO NOTHING;

-- Typo/Noise (fuzzy)
INSERT INTO benchmark_geocoding_samples (
  category, language, line1, city, district, province, country,
  expected_city_id, expected_district_id, expected_plugin, expected_outcome,
  has_typos
)
SELECT
  'typo', 'en', 'Olaya strt 12', 'Ryadh', 'Al Amall', 'Riyadh', 'SA',
  rc.id, da.id, 'fuzzy', 'should_match', true
FROM (
  SELECT id FROM canonical_cities WHERE lower(name_canonical) LIKE lower('Riyadh%') LIMIT 1
) rc,
(
  SELECT id FROM canonical_districts WHERE lower(name_canonical) LIKE lower('Al Amal%') LIMIT 1
) da
ON CONFLICT (id) DO NOTHING;

-- Long/noisy line (should trigger long_line + fallback)
INSERT INTO benchmark_geocoding_samples (
  category, language, line1, city, district, province, country,
  expected_city_id, expected_district_id, expected_plugin, expected_outcome,
  has_extra_tokens
)
SELECT
  'long_line', 'en',
  'Very long noisy address with extra tokens 12345 near Al Olaya Riyadh lorem ipsum dolor sit amet',
  'Riyadh', 'Al Olaya', 'Riyadh', 'SA',
  rc.id, d_olaya.id, 'long_line', 'should_fallback', true
FROM (
  SELECT id FROM canonical_cities WHERE lower(name_canonical) LIKE lower('Riyadh%') LIMIT 1
) rc,
(
  SELECT id FROM canonical_districts WHERE lower(name_canonical) LIKE lower('Al Olaya%') LIMIT 1
) d_olaya
ON CONFLICT (id) DO NOTHING;

-- Reverse local inside benchmark polygon
INSERT INTO benchmark_geocoding_samples (
  category, language, latitude, longitude, country,
  expected_sa_region_id, expected_sa_city_id, expected_sa_district_id,
  expected_plugin, expected_outcome
)
VALUES (
  'reverse_only', 'en', 24.71, 46.71, 'SA',
  9999, 9999, 9999,
  'reverse_local', 'should_match'
)
ON CONFLICT (id) DO NOTHING;

-- Ensure benchmark polygon exists
INSERT INTO sa_regions (id, name_en, geom, bbox, centroid)
VALUES (9999, 'Benchmark Region', ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_SetSRID(ST_MakePoint(46.7,24.7),4326))
ON CONFLICT (id) DO NOTHING;

INSERT INTO sa_cities (id, region_id, name_en, geom, bbox, centroid)
VALUES (9999, 9999, 'Benchmark City', ST_SetSRID(ST_MakePoint(46.7,24.7),4326), ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_SetSRID(ST_MakePoint(46.7,24.7),4326))
ON CONFLICT (id) DO NOTHING;

INSERT INTO sa_districts (id, city_id, region_id, name_en, geom, bbox, centroid)
VALUES (9999, 9999, 9999, 'Benchmark District', ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_GeomFromText('POLYGON((46.6 24.6,46.8 24.6,46.8 24.8,46.6 24.8,46.6 24.6))', 4326), ST_SetSRID(ST_MakePoint(46.7,24.7),4326))
ON CONFLICT (id) DO NOTHING;

COMMIT;
