-- Plan: PLAN-202601-extension-isolation / Step: S95
-- Migration: Re-apply PostGIS-owned relation grants lockdown (fixup).
-- Rationale: Supabase default privileges can (re)introduce anon/authenticated grants on extension-owned relations.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Ensure PostGIS is present (required by geocoding pipeline + pgTAP).
CREATE EXTENSION IF NOT EXISTS postgis;

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT n.nspname AS schema_name, c.relname AS rel_name, c.relkind
    FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    JOIN pg_class c ON c.oid = d.objid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE d.deptype = 'e'
      AND e.extname = 'postgis'
      AND c.relkind IN ('r', 'v', 'm', 'S')
    ORDER BY n.nspname, c.relname
  LOOP
    IF rec.relkind = 'S' THEN
      EXECUTE format(
        'REVOKE ALL ON SEQUENCE %I.%I FROM PUBLIC, anon, authenticated',
        rec.schema_name,
        rec.rel_name
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE %I.%I TO service_role',
        rec.schema_name,
        rec.rel_name
      );
    ELSE
      EXECUTE format(
        'REVOKE ALL ON TABLE %I.%I FROM PUBLIC, anon, authenticated',
        rec.schema_name,
        rec.rel_name
      );
      EXECUTE format(
        'GRANT SELECT ON TABLE %I.%I TO service_role',
        rec.schema_name,
        rec.rel_name
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

