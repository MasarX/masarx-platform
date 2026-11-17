-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S95
-- Migration: Register label_design_drafts in table_contracts (SSOT)
-- Purpose:
--   - Ensure new user-facing tables are covered by public.table_contracts for
--     timestamp/audit enforcement and pgTAP contract checks.
BEGIN;

SET search_path TO public, extensions, pg_temp;

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
  'label_design_drafts',
  TRUE,
  NULL,
  TRUE,
  NULL,
  TRUE,
  'Label designer drafts (user-facing; RLS enforced).'
)
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;
