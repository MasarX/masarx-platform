-- Migration: Benchmark seed fix (Riyadh/Al Amal/Al Olaya)
-- Purpose: Ensure benchmark corpus has labeled rows for perfect/typo/long_line categories.

BEGIN;

DELETE FROM benchmark_geocoding_samples WHERE category IN ('perfect','typo','long_line');

-- Perfect clean address
INSERT INTO benchmark_geocoding_samples (
  category, language, line1, city, district, province, country,
  expected_city_id, expected_district_id, expected_plugin, expected_outcome
)
SELECT
  'perfect', 'en', 'Olaya St 12', 'Riyadh', 'Al Amal Dist.', 'Riyadh', 'SA',
  rc.id, da.id, 'perfect', 'should_match'
FROM (
  SELECT id FROM canonical_cities WHERE lower(name_canonical) LIKE lower('Riyadh%') LIMIT 1
) rc,
(
  SELECT id FROM canonical_districts WHERE lower(name_canonical) LIKE lower('Al Amal%') LIMIT 1
) da;

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
) da;

-- Long/noisy line (should trigger long_line + fallback)
INSERT INTO benchmark_geocoding_samples (
  category, language, line1, city, district, province, country,
  expected_city_id, expected_district_id, expected_plugin, expected_outcome,
  has_extra_tokens
)
SELECT
  'long_line', 'en',
  'Very long noisy address with extra tokens 12345 near Al Olaya Riyadh lorem ipsum dolor sit amet',
  'Riyadh', 'Al Olaya Dist.', 'Riyadh', 'SA',
  rc.id, d_olaya.id, 'long_line', 'should_fallback', true
FROM (
  SELECT id FROM canonical_cities WHERE lower(name_canonical) LIKE lower('Riyadh%') LIMIT 1
) rc,
(
  SELECT id FROM canonical_districts WHERE lower(name_canonical) LIKE lower('Al Olaya%') LIMIT 1
) d_olaya;

COMMIT;
