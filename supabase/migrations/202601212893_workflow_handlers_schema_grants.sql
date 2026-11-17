-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Grant service_role access to workflow_handlers schema for workflow engine execution
-- Date: 2026-01-21

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212893_workflow_handlers_schema_grants'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- The workflow engine (service_role) must be able to execute handler functions
-- in workflow_handlers. Keep authenticated restricted; handlers are executed
-- via progress_workflow_run / service paths.
GRANT USAGE ON SCHEMA workflow_handlers TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA workflow_handlers TO service_role;

-- Ensure future handler functions are callable by service_role by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA workflow_handlers
GRANT EXECUTE ON FUNCTIONS TO service_role;

SELECT pg_advisory_unlock(hashtext('202601212893_workflow_handlers_schema_grants'));
COMMIT;

