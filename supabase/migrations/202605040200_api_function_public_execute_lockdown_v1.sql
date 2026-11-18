-- Migration: API function PUBLIC execute lockdown
-- Date: 2026-05-03
-- Purpose:
--   Re-assert deny-by-default execution on the PostgREST `api` schema after
--   late wrapper functions are created. PostgreSQL grants EXECUTE on functions
--   to PUBLIC by default unless explicitly revoked.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031370_api_function_public_execute_lockdown_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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

SELECT pg_advisory_unlock(hashtext('202605031370_api_function_public_execute_lockdown_v1'));
COMMIT;
