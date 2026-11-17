-- Migration: Register workflow_run_triggers + workflow_trigger_fires in table_contracts (timestamps + audit)
-- Purpose: Ensure timestamp/audit contracts include workflow run trigger tables (SSOT + pgTAP).
-- Plan: PLAN-202601-workflow-trigger-plugins-v1 / Step: S04

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  created_at_source_column,
  updated_at_required,
  updated_at_source_column,
  audit_enabled,
  notes
)
VALUES
  (
    'public',
    'workflow_run_triggers',
    TRUE,
    NULL,
    TRUE,
    NULL,
    TRUE,
    'Workflow-run trigger configuration (user-facing; audit enabled).'
  ),
  (
    'public',
    'workflow_trigger_fires',
    TRUE,
    NULL,
    TRUE,
    NULL,
    FALSE,
    'Idempotency/dispatch ledger for workflow-run triggers (internal; audit disabled).'
  )
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  created_at_source_column = EXCLUDED.created_at_source_column,
  updated_at_required = EXCLUDED.updated_at_required,
  updated_at_source_column = EXCLUDED.updated_at_source_column,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;

