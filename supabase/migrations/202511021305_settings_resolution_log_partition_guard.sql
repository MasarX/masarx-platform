-- Migration: Guard for settings_resolution_log current-month partition name collision
-- Purpose: If a current-month RANGE partition already exists under _p0 with suffix `_p0`,
--          create a temporary plain table with the non-suffixed name so that the later
--          202511021310_settings_resolution_log.sql migration skips creating a colliding
--          partition. Non-destructive; cleaned up by a subsequent migration.
-- Date: 2025-11-02 13:05 UTC

BEGIN;

DO $$
DECLARE
  v_from DATE := date_trunc('month', now())::date;
  v_to   DATE := (date_trunc('month', now()) + INTERVAL '1 month')::date;
  v_base TEXT := format('settings_resolution_log_%s_%s', EXTRACT(YEAR FROM v_from)::int, lpad(EXTRACT(MONTH FROM v_from)::int::text, 2, '0'));
  v_p0   TEXT := v_base || '_p0';
  has_parent boolean := to_regclass('public.settings_resolution_log') IS NOT NULL;
  has_hash   boolean := to_regclass('public.settings_resolution_log_p0') IS NOT NULL;
  has_range  boolean := to_regclass('public.' || v_p0) IS NOT NULL;
BEGIN
  -- Only guard if parent and hash partition exist and a current-month _p0 child exists
  IF has_parent AND has_hash AND has_range THEN
    -- Create a plain table with the non-suffixed name if it doesn't exist; this forces
    -- the later migration's name-based check to skip creating an overlapping partition.
    IF to_regclass('public.' || v_base) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I(id int)', v_base);
      EXECUTE format('COMMENT ON TABLE public.%I IS %L', v_base, 'Temporary guard table to avoid partition name collision; dropped by cleanup migration.');
    END IF;
  END IF;
END $$;

COMMIT;
