-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Migration: Workflow binding dispatch FK indexes
-- Purpose:
-- - Add supporting indexes for workflow binding dispatch foreign keys so
--   enterprise FK hygiene stays green.
BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_actor_user
  ON public.workflow_binding_dispatches (actor_user_id);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_client
  ON public.workflow_binding_dispatches (client_id);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_sender
  ON public.workflow_binding_dispatches (sender_id);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_settings
  ON public.workflow_binding_dispatches (settings_id);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_settings_version_scope
  ON public.workflow_binding_dispatches (settings_version_id, resolved_scope_hash);

COMMIT;
