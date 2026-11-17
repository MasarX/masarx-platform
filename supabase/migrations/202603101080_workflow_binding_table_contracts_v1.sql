-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Migration: Register workflow binding SSOT tables in table_contracts
-- Purpose:
-- - Ensure workflow binding substrate tables participate in canonical timestamp
--   and audit governance.
-- - Keep full local/CI pgTAP contract coverage green for workflow binding
--   registry, stage registry, and dispatch ledger tables.
BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES
  ('public', 'workflow_binding_registry', TRUE, TRUE, TRUE, 'Workflow binding registry (business-action contract catalog).'),
  ('public', 'workflow_binding_stage_registry', TRUE, TRUE, TRUE, 'Workflow binding stage registry (binding stage catalog).'),
  ('public', 'workflow_binding_dispatches', TRUE, TRUE, TRUE, 'Workflow binding dispatch ledger (resolved binding executions).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;
