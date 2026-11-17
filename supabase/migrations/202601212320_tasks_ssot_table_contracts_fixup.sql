-- Plan: PLAN-202601-tasks-ssot-core / Step: S04
-- Migration: Task SSOT table_contracts registration fixup (append-only)
-- Date: 2026-01-21
--
-- Why:
--   - All public base tables must have table_contracts rows (enforced by pgTAP).
--   - Task tables were added after the baseline seed and need explicit registration.
-- Notes:
--   - Idempotent: safe to run repeatedly.
--   - Append-only: do not edit historical migrations.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601212320_tasks_ssot_table_contracts_fixup'));
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
    'task_types',
    TRUE,
    NULL,
    TRUE,
    NULL,
    TRUE,
    'Task SSOT core catalog table.'
  ),
  (
    'public',
    'tasks',
    TRUE,
    NULL,
    TRUE,
    NULL,
    TRUE,
    'Task SSOT current-state projection. Canonical changes occur via RPCs.'
  ),
  (
    'public',
    'task_events',
    TRUE,
    NULL,
    FALSE,
    NULL,
    FALSE,
    'Task SSOT immutable event ledger (audit disabled to avoid redundant capture).'
  )
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601212320_tasks_ssot_table_contracts_fixup'));
COMMIT;

