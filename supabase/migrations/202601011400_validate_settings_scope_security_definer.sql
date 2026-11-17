-- Plan: PLAN-202601-label-designer-hardening / Step: S04
-- Migration: validate_settings_scope as SECURITY DEFINER
-- Purpose:
--   - Allow SECURITY DEFINER publish RPCs to write settings/settings_versions while
--     constraint triggers can still validate cross-table references.
--   - Avoid requiring authenticated callers to hold direct privileges on canonical
--     settings tables (SSOT + RLS preserved).
BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.validate_settings_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  scope_valid BOOLEAN := false;
  v_allowed_scopes JSONB;
BEGIN
  -- Category governance (optional): restrict which scopes may exist for a category.
  -- The FK from settings/settings_versions -> settings_category_registry ensures the row exists,
  -- but guard defensively for older environments during rolling upgrades.
  SELECT scr.allowed_scopes
    INTO v_allowed_scopes
    FROM public.settings_category_registry scr
   WHERE scr.category = NEW.category
   LIMIT 1;

  IF v_allowed_scopes IS NOT NULL AND jsonb_typeof(v_allowed_scopes) = 'array' THEN
    IF NOT (v_allowed_scopes ? NEW.scope_type) THEN
      RAISE EXCEPTION 'Scope "%" is not allowed for category "%"', NEW.scope_type, NEW.category
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Scope correctness: validate the referenced entity exists (or NULL for global).
  IF NEW.scope_type = 'global' THEN
    IF NEW.scope_id IS NULL THEN
      scope_valid := true;
    END IF;
  ELSIF NEW.scope_type = 'tenant' THEN
    SELECT TRUE INTO scope_valid FROM public.organizations WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'client' THEN
    SELECT TRUE INTO scope_valid FROM public.clients WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'sender' THEN
    SELECT TRUE INTO scope_valid FROM public.senders WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'resource' THEN
    SELECT TRUE INTO scope_valid FROM public.providers WHERE id = NEW.scope_id;
  ELSIF NEW.scope_type = 'source' THEN
    SELECT TRUE INTO scope_valid FROM public.webhook_sources WHERE id = NEW.scope_id;
  ELSE
    RAISE EXCEPTION 'Unsupported scope_type %', NEW.scope_type USING ERRCODE = '23514';
  END IF;

  IF NOT scope_valid THEN
    RAISE EXCEPTION 'Invalid scope %/% for % record %', NEW.scope_type, NEW.scope_id, TG_TABLE_NAME, NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'settings' THEN
    PERFORM 1
    FROM public.settings_versions sv
    WHERE sv.id = NEW.settings_version_id
      AND sv.scope_type = NEW.scope_type
      AND sv.scope_hash = NEW.scope_hash;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings row % references version % with mismatched scope', NEW.id, NEW.settings_version_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;

