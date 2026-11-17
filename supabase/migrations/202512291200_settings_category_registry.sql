-- Plan: PLAN-202512-system-defaults-prod-ready / Step: S02
-- Migration: Settings category registry (SSOT) + schema presence enforcement
-- Purpose:
--   - Introduce settings_category_registry as the SSOT for configuration category governance.
--   - Enforce that settings/settings_versions categories are registered.
--   - Enforce (presence only) that categories marked requires_schema have an active schema_registry entry.
-- Notes:
--   - JSON shape validation remains CI/test responsibility (Ajv + pgTAP), not DB triggers.
--   - Migrations are append-only; this is additive and safe to apply repeatedly.
BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) SSOT: settings_category_registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.settings_category_registry (
  category TEXT PRIMARY KEY,
  description TEXT,
  requires_schema BOOLEAN NOT NULL DEFAULT TRUE,
  requires_global_default BOOLEAN NOT NULL DEFAULT FALSE,
  side_effecting BOOLEAN NOT NULL DEFAULT FALSE,
  safe_missing_behavior TEXT NOT NULL DEFAULT 'return_null',
  allowed_scopes JSONB NOT NULL DEFAULT '["global","tenant","client","sender","source","resource"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settings_category_registry_category_ck CHECK (btrim(category) <> ''),
  CONSTRAINT settings_category_registry_safe_missing_behavior_ck CHECK (
    safe_missing_behavior IN ('return_null', 'skip', 'skip_with_ack', 'hard_fail')
  ),
  CONSTRAINT settings_category_registry_allowed_scopes_ck CHECK (
    jsonb_typeof(allowed_scopes) = 'array'
  )
);

DROP TRIGGER IF EXISTS trg_settings_category_registry_set_updated_at ON public.settings_category_registry;
CREATE TRIGGER trg_settings_category_registry_set_updated_at
BEFORE UPDATE ON public.settings_category_registry
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.settings_category_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.settings_category_registry FROM PUBLIC;
REVOKE ALL ON public.settings_category_registry FROM anon;
REVOKE ALL ON public.settings_category_registry FROM authenticated;

DROP POLICY IF EXISTS settings_category_registry_service_policy ON public.settings_category_registry;
CREATE POLICY settings_category_registry_service_policy ON public.settings_category_registry
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS settings_category_registry_read_policy ON public.settings_category_registry;
CREATE POLICY settings_category_registry_read_policy ON public.settings_category_registry
  FOR SELECT
  TO authenticated
  USING (TRUE);

GRANT SELECT ON public.settings_category_registry TO authenticated;
GRANT SELECT ON public.settings_category_registry TO service_role;

-- Seed: register any existing categories (schema_registry + settings_versions + settings).
INSERT INTO public.settings_category_registry (category)
SELECT c.category
FROM (
  SELECT DISTINCT category FROM public.schema_registry
  UNION
  SELECT DISTINCT category FROM public.settings_versions
  UNION
  SELECT DISTINCT category FROM public.settings
) c
WHERE c.category IS NOT NULL AND btrim(c.category) <> ''
ON CONFLICT (category) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) DB enforcement: categories must exist in registry (presence only)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'schema_registry_category_fk'
      AND conrelid = 'public.schema_registry'::regclass
  ) THEN
    ALTER TABLE public.schema_registry
      ADD CONSTRAINT schema_registry_category_fk
      FOREIGN KEY (category)
      REFERENCES public.settings_category_registry(category)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'settings_category_fk'
      AND conrelid = 'public.settings'::regclass
  ) THEN
    ALTER TABLE public.settings
      ADD CONSTRAINT settings_category_fk
      FOREIGN KEY (category)
      REFERENCES public.settings_category_registry(category)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE public.schema_registry VALIDATE CONSTRAINT schema_registry_category_fk;
ALTER TABLE public.settings VALIDATE CONSTRAINT settings_category_fk;

-- ---------------------------------------------------------------------------
-- 3) DB enforcement: requires_schema => schema_registry row must exist (presence only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_settings_category_schema_presence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_requires_schema BOOLEAN := TRUE;
BEGIN
  SELECT scr.requires_schema
    INTO v_requires_schema
    FROM public.settings_category_registry scr
   WHERE scr.category = NEW.category;

  IF COALESCE(v_requires_schema, TRUE) THEN
    PERFORM 1
      FROM public.schema_registry sr
     WHERE sr.category = NEW.category
       AND sr.is_active = TRUE
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'schema_registry missing for category: %', NEW.category USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settings_versions_category_schema_guard ON public.settings_versions;
CREATE CONSTRAINT TRIGGER settings_versions_category_schema_guard
AFTER INSERT OR UPDATE ON public.settings_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_settings_category_schema_presence();

DROP TRIGGER IF EXISTS settings_category_schema_guard ON public.settings;
CREATE CONSTRAINT TRIGGER settings_category_schema_guard
AFTER INSERT OR UPDATE ON public.settings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_settings_category_schema_presence();

COMMIT;
