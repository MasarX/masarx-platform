-- Migration: label_design canonical seed alignment
-- Purpose:
--   - Retire legacy tenant-scoped label_design demo/default seed behavior from active migrations.
--   - Preserve chain order while relying on canonical global + onboarding bootstrap defaults.

BEGIN;

DO $$
BEGIN
  RAISE NOTICE 'Legacy tenant-specific label_design seed retired; canonical defaults are policy-driven via onboarding bootstrap.';
END;
$$;

COMMIT;
