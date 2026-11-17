-- Migration: Seed audit redaction rules for sensitive columns (row-driven)
-- Date: 2025-12-29
--
-- Purpose:
--   - Provide safe-by-default redaction for obvious secret/PII payload columns
--     without hardcoding table-specific logic in triggers.
--   - Rules are data-defined in audit_redaction_rules; this migration only seeds
--     a baseline denylist when no rule exists yet.
BEGIN;

WITH sensitive AS (
  SELECT
    c.table_schema,
    c.table_name,
    array_agg(c.column_name ORDER BY c.column_name) AS cols
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
  JOIN pg_catalog.pg_class pc
    ON pc.relname = c.table_name
  JOIN pg_catalog.pg_namespace pn
    ON pn.oid = pc.relnamespace
   AND pn.nspname = c.table_schema
  WHERE c.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
    AND pc.relkind IN ('r','p')
    AND pc.relispartition = false
    AND c.table_name <> 'audit_table_changes'
    AND c.table_name NOT LIKE 'audit_table_changes%'
    AND (
      -- credentials/secrets/tokens/passwords
      c.column_name ~* '(password|passwd|secret|token|api[_-]?key|apikey|jwt|authorization|credentials)'
      -- large payload carriers
      OR c.column_name IN ('raw_payload', 'payload', 'headers', 'request', 'request_body', 'response', 'response_body')
    )
  GROUP BY c.table_schema, c.table_name
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
  COALESCE(s.cols, '{}'::text[]),
  '[REDACTED]'
FROM sensitive s
WHERE array_length(s.cols, 1) IS NOT NULL
  AND array_length(s.cols, 1) > 0
ON CONFLICT (table_schema, table_name) DO NOTHING;

COMMIT;

