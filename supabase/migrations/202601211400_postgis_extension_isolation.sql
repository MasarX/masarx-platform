-- Plan: PLAN-202601-extension-isolation / Step: S04
-- Migration: Lock down PostGIS-owned relations (defense-in-depth)
--
-- Goals
-- - Ensure extension-owned relations (e.g., spatial_ref_sys) are not reachable by `anon`/`authenticated`.
-- - Avoid API exposure surprises and RLS tooling friction on extension tables.
-- - Keep behavior idempotent and environment-agnostic (no manual steps).

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Ensure PostGIS is present (required by the geocoding pipeline + pgTAP).
-- Note: PostGIS is not relocatable in this project (pg_extension.extrelocatable=false),
-- so we harden privileges instead of attempting ALTER EXTENSION ... SET SCHEMA.
CREATE EXTENSION IF NOT EXISTS postgis;

DO $$
DECLARE
  rec RECORD;
BEGIN
  -- Lock down PostGIS-owned relations:
  -- no PUBLIC/anon/authenticated access; service_role-only for admin/debug use.
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
