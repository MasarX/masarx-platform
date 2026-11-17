-- Migration: Retired pre-GA fixture policy sync
-- Purpose:
--   - Preserve migration ordering without applying fixture-client policy mutations.
--   - Tenant/client webhook policy materialization is now resolver-driven and test fixtures
--     are bootstrapped outside active migrations.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
BEGIN
  RAISE NOTICE 'Retired fixture policy sync migration; no-op by design.';
END;
$$;

COMMIT;
