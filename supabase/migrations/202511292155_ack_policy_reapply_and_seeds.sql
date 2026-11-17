-- Migration: Retired pre-GA fixture seed migration
-- Purpose:
--   - Preserve migration chain ordering without seeding test/demo rows in active environments.
--   - Test fixtures are now bootstrap-only (scripts/tests/bootstrap/*).

BEGIN;

SET search_path TO public, pg_temp;

DO $$
BEGIN
  RAISE NOTICE 'Retired fixture seed migration; no-op by design.';
END $$;

COMMIT;
