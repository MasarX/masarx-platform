-- Test: baseline audit_redaction_rules coverage for audited tables with sensitive columns
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(1);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.table_contracts tc
    JOIN pg_class pc ON pc.relname = tc.table_name
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND pc.relkind IN ('r','p')
      AND pc.relispartition = false
      AND tc.audit_enabled IS TRUE
      AND tc.table_name <> 'audit_table_changes'
      AND tc.table_name NOT LIKE 'audit_table_changes%'
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = tc.table_schema
          AND c.table_name = tc.table_name
          AND (
            c.column_name ~* '(password|passwd|secret|token|api[_-]?key|apikey|jwt|authorization|credentials)'
            OR c.column_name IN ('raw_payload', 'payload', 'headers', 'request', 'request_body', 'response', 'response_body')
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.audit_redaction_rules ar
        WHERE ar.table_schema = tc.table_schema
          AND ar.table_name = tc.table_name
      )
  ),
  'Audited tables with sensitive columns have audit_redaction_rules rows'
);

SELECT finish();
ROLLBACK;

