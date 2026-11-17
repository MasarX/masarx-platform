-- Migration: Workflow handlers search_path fix
-- Purpose: Ensure all functions within workflow_handlers schema resolve shared types and tables.

BEGIN;

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT p.oid::regprocedure AS proc
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'workflow_handlers'
    LOOP
        EXECUTE format(
            'ALTER FUNCTION %s SET search_path TO workflow_handlers, public, extensions, pg_temp',
            rec.proc
        );
    END LOOP;
END;
$$;

COMMIT;
