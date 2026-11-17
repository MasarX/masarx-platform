-- Plan: PLAN-202601-schema-prod-finalization / Step: S95
-- Test: PostGIS-owned relations are not exposed via the `api` contract schema
--
-- Rationale
-- - Supabase owns some extension relations (e.g., PostGIS spatial_ref_sys) under `supabase_admin`.
--   Those ACLs are managed outside our control (not writable as `postgres` in this project).
-- - Enterprise-grade boundary: keep the REST surface constrained to `api` schema objects and ensure
--   extension relations are never surfaced there.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE EXTENSION IF NOT EXISTS postgis;

SELECT plan(3);

SELECT is(
  to_regclass('api.spatial_ref_sys'),
  NULL::regclass,
  'api.spatial_ref_sys does not exist (extension relations must not be exposed via api schema)'
);

SELECT is(
  to_regclass('api.geometry_columns'),
  NULL::regclass,
  'api.geometry_columns does not exist (extension relations must not be exposed via api schema)'
);

SELECT is(
  to_regclass('api.geography_columns'),
  NULL::regclass,
  'api.geography_columns does not exist (extension relations must not be exposed via api schema)'
);

SELECT finish();

ROLLBACK;
