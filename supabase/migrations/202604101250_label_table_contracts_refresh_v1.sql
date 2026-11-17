-- Migration: label table contracts refresh
-- Purpose:
--   - Register label_artifacts and label_versions in public.table_contracts.
--   - Reconcile canonical timestamp/audit behavior for the newly registered tables.

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
VALUES
  (
    'public',
    'label_artifacts',
    TRUE,
    NULL,
    TRUE,
    NULL,
    TRUE,
    'Canonical persistence for target-neutral label outputs.'
  ),
  (
    'public',
    'label_versions',
    TRUE,
    NULL,
    TRUE,
    NULL,
    TRUE,
    'Immutable label lineage with one active version per stable label identity.'
  )
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;
