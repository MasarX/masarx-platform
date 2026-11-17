-- Test: table_contracts enforces canonical timestamps + audit enablement
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

SELECT has_table('public', 'table_contracts', 'table_contracts exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='table_contracts'), 'RLS enabled on table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='table_contracts'), 'table_contracts has policies');

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND c.relname <> 'spatial_ref_sys'
      AND NOT EXISTS (
        SELECT 1
        FROM public.table_contracts tc
        WHERE tc.table_schema = n.nspname
          AND tc.table_name = c.relname
      )
  ),
  'All public base tables have table_contracts rows'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    JOIN pg_class c ON c.relname = tc.table_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND tc.created_at_required IS TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns col
        WHERE col.table_schema = tc.table_schema
          AND col.table_name = tc.table_name
          AND col.column_name = 'created_at'
          AND col.data_type = 'timestamp with time zone'
      )
  ),
  'created_at_required satisfied for contract-scoped tables'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    JOIN pg_class c ON c.relname = tc.table_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND tc.updated_at_required IS TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns col
        WHERE col.table_schema = tc.table_schema
          AND col.table_name = tc.table_name
          AND col.column_name = 'updated_at'
          AND col.data_type = 'timestamp with time zone'
      )
  ),
  'updated_at_required satisfied for contract-scoped tables'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    JOIN information_schema.columns col
      ON col.table_schema = tc.table_schema
     AND col.table_name = tc.table_name
     AND col.column_name = 'updated_at'
    JOIN pg_class c ON c.relname = tc.table_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND tc.updated_at_required IS TRUE
      AND COALESCE(col.is_generated, 'NEVER') = 'NEVER'
      AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_trigger tg
         WHERE tg.tgrelid = c.oid
           AND tg.tgname = left(format('trg_%s_set_updated_at', tc.table_name), 63)
       )
   ),
   'Physical updated_at columns have standard set_updated_at trigger'      
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    JOIN pg_class c ON c.relname = tc.table_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND tc.audit_enabled IS NOT TRUE
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger tg
        WHERE tg.tgrelid = c.oid
          AND tg.tgname IN ('audit_row_change', 'audit_truncate_change')  
      )
  ),
  'Audit-disabled tables do not have audit triggers'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    JOIN pg_class c ON c.relname = tc.table_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND tc.audit_enabled IS TRUE
      AND tc.table_name <> 'audit_table_changes'
      AND tc.table_name NOT LIKE 'audit_table_changes%'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger tg
          WHERE tg.tgrelid = c.oid
            AND tg.tgname = 'audit_row_change'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger tg
          WHERE tg.tgrelid = c.oid
            AND tg.tgname = 'audit_truncate_change'
        )
      )
  ),
  'Audit-enabled tables have audit triggers'
);

SELECT finish();
ROLLBACK;
