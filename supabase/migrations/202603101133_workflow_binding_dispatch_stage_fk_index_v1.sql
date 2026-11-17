-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Migration: Workflow binding dispatch stage FK index
-- Purpose:
-- - Add a full non-partial index for binding/stage foreign key coverage.
BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_binding_stage
  ON public.workflow_binding_dispatches (binding_key, stage_key);

COMMIT;
