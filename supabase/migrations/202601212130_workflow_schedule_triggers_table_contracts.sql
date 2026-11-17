-- Migration: Register workflow_schedule_triggers in table_contracts (timestamps + audit)
-- Purpose: Ensure timestamp/audit contracts include workflow_schedule_triggers (SSOT + pgTAP).
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

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
VALUES (
  'public',
  'workflow_schedule_triggers',
  TRUE,
  NULL,
  TRUE,
  NULL,
  TRUE,
  'Workflow schedule triggers configuration (user-facing; audit enabled).'
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

