-- Migration: Resolve settings row from execution context (canonical helper)
-- Purpose:
--   - Centralize "best available scope" selection for categories that follow the standard ladder:
--       Source > Sender > Client > Tenant > Global
--   - Avoid repeating ad-hoc scope selection logic inside business functions.
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_settings_row_from_context(
  p_category TEXT,
  p_context JSONB
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT := 'global';
  v_scope_id UUID := NULL;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN;
  END IF;

  IF p_context IS NULL OR jsonb_typeof(p_context) <> 'object' THEN
    RETURN QUERY
    SELECT * FROM public.resolve_settings_row(p_category, 'global', NULL) LIMIT 1;
    RETURN;
  END IF;

  BEGIN
    v_scope_id := NULLIF(p_context->>'webhook_source_id', '')::UUID;
    IF v_scope_id IS NOT NULL THEN
      v_scope_type := 'source';
    END IF;
  EXCEPTION
    WHEN others THEN
      v_scope_id := NULL;
  END;

  IF v_scope_id IS NULL THEN
    BEGIN
      v_scope_id := NULLIF(p_context->>'sender_id', '')::UUID;
      IF v_scope_id IS NOT NULL THEN
        v_scope_type := 'sender';
      END IF;
    EXCEPTION
      WHEN others THEN
        v_scope_id := NULL;
    END;
  END IF;

  IF v_scope_id IS NULL THEN
    BEGIN
      v_scope_id := NULLIF(p_context->>'client_id', '')::UUID;
      IF v_scope_id IS NOT NULL THEN
        v_scope_type := 'client';
      END IF;
    EXCEPTION
      WHEN others THEN
        v_scope_id := NULL;
    END;
  END IF;

  IF v_scope_id IS NULL THEN
    BEGIN
      v_scope_id := NULLIF(p_context->>'organization_id', '')::UUID;
      IF v_scope_id IS NOT NULL THEN
        v_scope_type := 'tenant';
      END IF;
    EXCEPTION
      WHEN others THEN
        v_scope_id := NULL;
    END;
  END IF;

  RETURN QUERY
  SELECT * FROM public.resolve_settings_row(p_category, v_scope_type, v_scope_id) LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.resolve_settings_row_from_context(TEXT, JSONB)
  IS 'Resolve a settings row via ladder using the best-available scope id in context (webhook_source_id/sender_id/client_id/organization_id).';

COMMIT;

