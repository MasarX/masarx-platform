-- Plan: PLAN-202601-extension-isolation / Step: S04
-- Migration: Fix find_extent search_path proconfig quoting
--
-- Note
-- - Setting search_path via a single quoted string stores a value like:
--     search_path="public, extensions, pg_temp"
--   which is interpreted as ONE schema name (including commas), breaking
--   name resolution inside dynamic SQL.
-- - Use the canonical unquoted list form instead.

BEGIN;

ALTER FUNCTION public.find_extent(regclass, text) SET search_path = public, extensions, pg_temp;

COMMIT;

