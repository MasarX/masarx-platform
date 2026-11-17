-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Fix SECURITY DEFINER search_path for lock_down_extension_owned_relations_v1.
--
-- Rationale
-- - Guardrail: all project SECURITY DEFINER functions must pin search_path to
--   `public[, extensions|workflow_handlers], pg_temp` (no extra schemas).
-- - Keep catalog access explicit via pg_catalog.* references (no reliance on search_path).

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.lock_down_extension_owned_relations_v1(p_extname TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  rec RECORD;
BEGIN
  IF p_extname IS NULL OR btrim(p_extname) = '' THEN
    RAISE EXCEPTION 'lock_down_extension_owned_relations_v1: p_extname is required';
  END IF;

  FOR rec IN
    SELECT n.nspname AS schema_name, c.relname AS rel_name, c.relkind
    FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
    JOIN pg_catalog.pg_class c ON c.oid = d.objid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE d.deptype = 'e'
      AND e.extname = p_extname
      AND c.relkind IN ('r', 'v', 'm', 'S')
    ORDER BY n.nspname, c.relname
  LOOP
    IF rec.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM PUBLIC', rec.schema_name, rec.rel_name);
      EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM anon', rec.schema_name, rec.rel_name);
      EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM authenticated', rec.schema_name, rec.rel_name);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I.%I TO service_role', rec.schema_name, rec.rel_name);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC', rec.schema_name, rec.rel_name);
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', rec.schema_name, rec.rel_name);
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM authenticated', rec.schema_name, rec.rel_name);
      EXECUTE format('GRANT SELECT ON TABLE %I.%I TO service_role', rec.schema_name, rec.rel_name);
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.lock_down_extension_owned_relations_v1(TEXT) IS
  'Revoke anon/authenticated/PUBLIC privileges on extension-owned relations (tables/views/sequences) and grant service_role read access.';

REVOKE ALL ON FUNCTION public.lock_down_extension_owned_relations_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_down_extension_owned_relations_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.lock_down_extension_owned_relations_v1(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lock_down_extension_owned_relations_v1(TEXT) TO service_role;

-- Re-apply after redefining the function (idempotent).
SELECT public.lock_down_extension_owned_relations_v1('postgis');

COMMIT;

