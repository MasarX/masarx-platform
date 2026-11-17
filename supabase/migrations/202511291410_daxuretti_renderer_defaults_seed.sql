-- Migration: renderer_defaults canonical seed alignment
-- Purpose:
--   - Retire legacy tenant-scoped demo/default seed behavior from active migrations.
--   - Keep migration chain continuity while enforcing canonical global/onboarding defaults only.

BEGIN;

DO $$
BEGIN
  RAISE NOTICE 'Legacy tenant-specific renderer_defaults seed retired; canonical defaults are policy-driven via onboarding bootstrap.';
END;
$$;

COMMIT;
