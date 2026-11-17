-- Plan: PLAN-202603-shared-mapping-studio / Step: S95
-- Migration: Register mapping studio + resource import SSOT tables in table_contracts
--
-- Purpose:
--   - Ensure new public base tables added by the shared mapping studio and universal
--     resource import flow are represented in public.table_contracts.
--   - Keep canonical timestamp and audit enforcement row-driven through
--     public.apply_table_contracts() and public.ensure_audit_triggers().

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091310_table_contracts_resource_import_fixup_v1'));
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
  ('public', 'mapping_operation_reports', TRUE, TRUE, TRUE, 'Persisted mapping/import operation evidence and submit reports.'),
  ('public', 'tabular_import_runs', TRUE, TRUE, TRUE, 'SSOT parent rows for prepared and executed tabular import runs.'),
  ('public', 'tabular_import_run_rows', TRUE, TRUE, TRUE, 'SSOT staged row ledger for tabular import dry-runs and execution outcomes.')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202603091310_table_contracts_resource_import_fixup_v1'));
COMMIT;
