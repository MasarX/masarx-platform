-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Re-apply PostGIS-owned relation grants lockdown (defense-in-depth).
--
-- Rationale
-- - Supabase defaults and/or extension upgrades can re-introduce anon/authenticated grants on
--   PostGIS-owned relations (e.g., public.spatial_ref_sys), which are not part of our API surface.
-- - Keep this behavior dynamic and idempotent: derive owned relations from pg_depend/pg_extension.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.lock_down_extension_owned_relations_v1(p_extname TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  rec RECORD;
BEGIN
  IF p_extname IS NULL OR btrim(p_extname) = '' THEN
    RAISE EXCEPTION 'lock_down_extension_owned_relations_v1: p_extname is required';
  END IF;

  FOR rec IN
    SELECT n.nspname AS schema_name, c.relname AS rel_name, c.relkind
    FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    JOIN pg_class c ON c.oid = d.objid
    JOIN pg_namespace n ON n.oid = c.relnamespace
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

-- Ensure PostGIS is present (required by geocoding pipeline + pgTAP).
CREATE EXTENSION IF NOT EXISTS postgis;

-- Re-apply the lockdown for PostGIS-owned relations (e.g., spatial_ref_sys, geometry_columns).
SELECT public.lock_down_extension_owned_relations_v1('postgis');

COMMIT;

