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

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC, anon;

SELECT pg_advisory_unlock(hashtext('202605031370_api_function_public_execute_lockdown_v1'));
COMMIT;
