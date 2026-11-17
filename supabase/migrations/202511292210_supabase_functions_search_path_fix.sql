-- Migration: Align supabase_functions.http_request search_path with security policy
-- Purpose: ensure the security definer http_request trigger helper pins search_path to public/ extensions/ pg_temp.

BEGIN;

DO $$
BEGIN
    IF to_regprocedure('supabase_functions.http_request()') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION supabase_functions.http_request() SET search_path TO public, extensions, pg_temp';
    END IF;
END $$;

COMMIT;

