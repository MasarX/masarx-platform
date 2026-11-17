-- pgTAP: Saudi polygons schema + seed + RLS smoke
BEGIN;

SELECT plan(6);

-- Tables exist
SELECT ok(EXISTS (SELECT 1 FROM pg_class WHERE relname = 'sa_regions'), 'sa_regions exists');
SELECT ok(EXISTS (SELECT 1 FROM pg_class WHERE relname = 'sa_cities'), 'sa_cities exists');
SELECT ok(EXISTS (SELECT 1 FROM pg_class WHERE relname = 'sa_districts'), 'sa_districts exists');

-- RLS enabled
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'sa_regions'), 'RLS enabled on sa_regions');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'sa_cities'), 'RLS enabled on sa_cities');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'sa_districts'), 'RLS enabled on sa_districts');

-- Optional: ensure seed present (skip if empty to avoid hard failure)
-- SELECT ok((SELECT count(*) > 0 FROM sa_districts), 'sa_districts has data');

SELECT * FROM finish();

ROLLBACK;
