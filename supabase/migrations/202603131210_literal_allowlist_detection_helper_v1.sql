-- Migration: Literal allowlist detection helper v1
-- Purpose:
--   - Centralize detection of enum-like literal allowlists in CHECK definitions.
--   - Avoid false positives on non-enum SQL forms such as POSITION('@' IN email).

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.constraint_has_literal_allowlist_v1(p_definition TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    p_definition ~* E'\\mANY\\M\\s*\\(\\s*ARRAY\\s*\\['
    OR p_definition ~* E'\\mIN\\M\\s*\\(\\s*(?:''(?:[^'']|'''')*''|[-+]?[0-9]+(?:\\.[0-9]+)?\\b|true\\b|false\\b|null\\b)',
    false
  );
$$;

COMMENT ON FUNCTION public.constraint_has_literal_allowlist_v1(TEXT)
IS 'Returns true when a CHECK definition contains an enum-like literal allowlist, excluding non-enum IN syntax such as POSITION(... IN column).';

COMMIT;
