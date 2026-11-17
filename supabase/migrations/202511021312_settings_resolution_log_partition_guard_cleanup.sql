-- Migration: Cleanup guard for settings_resolution_log partition name collision
-- Purpose: Drop the temporary plain table created by 202511021305_settings_resolution_log_partition_guard.sql
--          once the real current-month partition exists (with _p0 suffix) under the hash parent.
-- Date: 2025-11-02 13:12 UTC

BEGIN;

DO $$
DECLARE
  v_from DATE := date_trunc('month', now())::date;
  v_base TEXT := format('settings_resolution_log_%s_%s', EXTRACT(YEAR FROM v_from)::int, lpad(EXTRACT(MONTH FROM v_from)::int::text, 2, '0'));
  v_p0   TEXT := v_base || '_p0';
  has_hash   boolean := to_regclass('public.settings_resolution_log_p0') IS NOT NULL;
  has_range  boolean := to_regclass('public.' || v_p0) IS NOT NULL;
  has_guard  boolean := to_regclass('public.' || v_base) IS NOT NULL;
BEGIN
  IF has_hash AND has_range AND has_guard THEN
    EXECUTE format('DROP TABLE IF EXISTS public.%I', v_base);
  END IF;
END $$;

COMMIT;

