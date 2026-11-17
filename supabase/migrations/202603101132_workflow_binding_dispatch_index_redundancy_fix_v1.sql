-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose:
-- - Remove exact duplicate workflow_binding_dispatches indexes after merging
--   generic FK-index hygiene with earlier explicit workflow-binding indexes.
-- - Preserve the canonical FK-hygiene/generated indexes and drop only the
--   redundant explicit copies.

BEGIN;

SET search_path TO public, extensions, pg_temp;

DROP INDEX IF EXISTS public.idx_workflow_binding_dispatches_binding_stage;
DROP INDEX IF EXISTS public.idx_workflow_binding_dispatches_actor_user;
DROP INDEX IF EXISTS public.idx_workflow_binding_dispatches_client;
DROP INDEX IF EXISTS public.idx_workflow_binding_dispatches_sender;
DROP INDEX IF EXISTS public.idx_workflow_binding_dispatches_settings;
DROP INDEX IF EXISTS public.idx_workflow_binding_dispatches_settings_version_scope;

COMMIT;
