-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Reconcile audit redaction rules for newly added audited sensitive tables

BEGIN;

WITH audited_sensitive AS (
  SELECT
    tc.table_schema,
    tc.table_name,
    array_agg(c.column_name ORDER BY c.column_name) AS cols
  FROM public.table_contracts tc
  JOIN pg_catalog.pg_namespace pn
    ON pn.nspname = tc.table_schema
  JOIN pg_catalog.pg_class pc
    ON pc.relnamespace = pn.oid
   AND pc.relname = tc.table_name
  JOIN information_schema.columns c
    ON c.table_schema = tc.table_schema
   AND c.table_name = tc.table_name
  WHERE tc.table_schema = 'public'
    AND tc.audit_enabled IS TRUE
    AND pc.relkind IN ('r', 'p')
    AND pc.relispartition = false
    AND tc.table_name <> 'audit_table_changes'
    AND tc.table_name NOT LIKE 'audit_table_changes%'
    AND (
      c.column_name ~* '(password|passwd|secret|token|api[_-]?key|apikey|jwt|authorization|credentials)'
      OR c.column_name IN (
        'raw_payload',
        'payload',
        'headers',
        'request',
        'request_body',
        'response',
        'response_body'
      )
    )
  GROUP BY tc.table_schema, tc.table_name
)
INSERT INTO public.audit_redaction_rules (
  table_schema,
  table_name,
  mode,
  columns,
  redaction_token
)
SELECT
  s.table_schema,
  s.table_name,
  'denylist',
  s.cols,
  '[REDACTED]'
FROM audited_sensitive s
WHERE array_length(s.cols, 1) IS NOT NULL
  AND array_length(s.cols, 1) > 0
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  mode = EXCLUDED.mode,
  columns = EXCLUDED.columns,
  redaction_token = EXCLUDED.redaction_token,
  updated_at = now();

COMMIT;
