-- Reconcile duplicate run_id/row_number indexing on tabular import rows.
-- The UNIQUE constraint already owns the canonical btree index for this key,
-- so the standalone lookup index is redundant and violates the zero-redundancy contract.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tabular_import_run_rows'
      AND indexname = 'idx_tabular_import_run_rows_run_row'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
        AND conrelid = 'public.tabular_import_run_rows'::regclass
        AND conname = 'tabular_import_run_rows_unique_row'
        AND contype = 'u'
    ) THEN
      RAISE EXCEPTION
        'Cannot drop public.idx_tabular_import_run_rows_run_row because required UNIQUE constraint public.tabular_import_run_rows_unique_row is missing';
    END IF;

    EXECUTE 'DROP INDEX public.idx_tabular_import_run_rows_run_row';
  END IF;
END
$$;
