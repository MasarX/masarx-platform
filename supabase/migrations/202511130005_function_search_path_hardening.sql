-- Migration: Function search_path hardening
-- Purpose: Eliminate mutable search_path warnings by explicitly setting per-function search_path
-- Date: 2025-11-13

BEGIN;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','workflow_handlers')
      AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = %s',
      r.nspname, r.proname, r.args,
      CASE WHEN r.nspname = 'public' THEN quote_literal('public, pg_temp')
           ELSE quote_literal(r.nspname || ', public, pg_temp') END);
  END LOOP;
END $$ LANGUAGE plpgsql;

COMMIT;

