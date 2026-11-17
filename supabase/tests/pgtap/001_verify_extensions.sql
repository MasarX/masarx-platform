-- Test file: 001_verify_extensions.sql
-- Purpose: Verify PostgreSQL extensions and helper functions are enabled
-- Task: 2.1 - Write 2-4 focused tests for extensions and helper functions

BEGIN;

-- Declare test plan: 3 tests total
SELECT plan(3);

-- Test 1: Verify PostGIS extension is enabled
SELECT has_extension(
    'postgis',
    'PostGIS extension should be enabled for geocoding and spatial operations'
);

-- Test 2: Verify pgcrypto extension is enabled (for gen_random_uuid and crypt helpers)
SELECT has_extension(
    'pgcrypto',
    'pgcrypto extension should be enabled for gen_random_uuid() and cryptographic helpers'
);

-- Test 3: Verify pg_stat_statements extension is enabled
SELECT has_extension(
    'pg_stat_statements',
    'pg_stat_statements extension should be enabled for query performance monitoring'
);

-- Finish tests
SELECT * FROM finish();

ROLLBACK;
