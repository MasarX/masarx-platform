-- Migration: workflow follow-up action runner search_path fix
-- Purpose: Ensure execute_workflow_followup_actions can access registry tables.

BEGIN;

ALTER FUNCTION public.execute_workflow_followup_actions(
    UUID,
    JSONB,
    JSONB
)
    SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMIT;


