-- Plan: PLAN-202601-scope-projection-integrity / Step: S04
-- Migration: Ensure table_contracts coverage for new contract tables (scope_projection_contracts)
--
-- Why
-- - pgTAP enforces that every public base table is represented in public.table_contracts (SSOT).
-- - scope_projection_contracts is a new base table and must be included so timestamp/audit enforcement stays complete.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'scope_projection_contracts',
  TRUE,
  TRUE,
  TRUE,
  'Internal SSOT contract table for scope projection enforcement (audit enabled; service-only).'
)
ON CONFLICT (table_schema, table_name) DO NOTHING;

-- Re-apply contracts and reconcile audit triggers (idempotent).
SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;

