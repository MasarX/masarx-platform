-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Migration: Workflow binding API contract views
-- Purpose:
-- - Expose workflow binding SSOT tables through api.* contract views so
--   user-facing RLS surfaces stay PostgREST-compatible.
-- - Keep api contract pgTAP coverage green for workflow binding registry and
--   dispatch tables.
BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;

CREATE OR REPLACE VIEW api.workflow_binding_registry
WITH (security_invoker = true)
AS
SELECT * FROM public.workflow_binding_registry;

CREATE OR REPLACE VIEW api.workflow_binding_stage_registry
WITH (security_invoker = true)
AS
SELECT * FROM public.workflow_binding_stage_registry;

CREATE OR REPLACE VIEW api.workflow_binding_dispatches
WITH (security_invoker = true)
AS
SELECT * FROM public.workflow_binding_dispatches;

REVOKE ALL ON api.workflow_binding_registry FROM PUBLIC;
REVOKE ALL ON api.workflow_binding_stage_registry FROM PUBLIC;
REVOKE ALL ON api.workflow_binding_dispatches FROM PUBLIC;
REVOKE ALL ON api.workflow_binding_registry FROM anon;
REVOKE ALL ON api.workflow_binding_stage_registry FROM anon;
REVOKE ALL ON api.workflow_binding_dispatches FROM anon;
REVOKE ALL ON api.workflow_binding_registry FROM authenticated;
REVOKE ALL ON api.workflow_binding_stage_registry FROM authenticated;
REVOKE ALL ON api.workflow_binding_dispatches FROM authenticated;

GRANT SELECT ON api.workflow_binding_registry TO authenticated;
GRANT SELECT ON api.workflow_binding_stage_registry TO authenticated;
GRANT SELECT ON api.workflow_binding_dispatches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.workflow_binding_registry TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.workflow_binding_stage_registry TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.workflow_binding_dispatches TO service_role;

COMMIT;
