-- Migration: Retired pre-GA fixture ACK mapping reset
-- Purpose:
--   - Preserve migration ordering without mutating fixture-client webhook policy rows.
--   - Test-specific policy behavior must be applied through non-production bootstrap scripts.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
BEGIN
  RAISE NOTICE 'Retired fixture ACK mapping reset migration; no-op by design.';
END $$;

COMMIT;
