-- Plan: PLAN-202603-shared-mapping-studio / Step: S95
-- Migration: Reconcile API PUBLIC execute revokes v1
--
-- Purpose:
--   - Ensure api-schema functions do not remain executable through inherited
--     PUBLIC grants in shared/cloud environments.
--   - Keep the API boundary fail-closed for unauthenticated callers by removing
--     default PUBLIC execute exposure dynamically across all api functions.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091350_api_public_execute_revoke_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON SCHEMA api FROM PUBLIC;

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT n.nspname AS schema_name, c.relname AS rel_name, c.relkind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'api'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    ORDER BY c.relkind, c.relname
  LOOP
    IF rec.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %I.%I FROM PUBLIC', rec.schema_name, rec.rel_name);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC', rec.schema_name, rec.rel_name);
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  rec RECORD;
  v_identity_args TEXT;
BEGIN
  FOR rec IN
    SELECT p.oid, p.proname
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'api'
    ORDER BY p.proname, p.oid
  LOOP
    v_identity_args := pg_catalog.pg_get_function_identity_arguments(rec.oid);
    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM PUBLIC', rec.proname, v_identity_args);
    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM anon', rec.proname, v_identity_args);
  END LOOP;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603091350_api_public_execute_revoke_reconcile_v1'));
COMMIT;
