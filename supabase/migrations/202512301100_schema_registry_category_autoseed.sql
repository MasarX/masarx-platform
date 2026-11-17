-- Plan: PLAN-202512-system-defaults-prod-ready / Step: S02
-- Migration: Auto-seed settings_category_registry from schema_registry writes
-- Purpose:
--   - Keep schema_registry FK enforcement compatible with `supabase db push --include-all`.
--   - Prevent out-of-order application of older migrations from failing when they
--     introduce a new schema_registry category after the registry FK is already
--     present on the target database.
-- Notes:
--   - Inserts a minimal registry row (default governance values). Operators can
--     later refine category metadata (safe_missing_behavior, allowed_scopes, etc.).
BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ensure_settings_category_registry_from_schema_registry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.category IS NULL OR btrim(NEW.category) = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.settings_category_registry (category)
  VALUES (NEW.category)
  ON CONFLICT (category) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS schema_registry_category_autoseed ON public.schema_registry;
CREATE TRIGGER schema_registry_category_autoseed
BEFORE INSERT OR UPDATE OF category ON public.schema_registry
FOR EACH ROW EXECUTE FUNCTION public.ensure_settings_category_registry_from_schema_registry();

COMMIT;
