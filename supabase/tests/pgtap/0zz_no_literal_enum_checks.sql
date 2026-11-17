-- Plan: PLAN-202601-schema-prod-finalization / Step: S95
-- Test: No literal-list enum CHECK constraints in app schemas
--
-- Objective: ZERO HARD CODING. Business-facing enums must be row-driven via lookup contracts,
-- not embedded as literal allowlists in CHECK constraints.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

CREATE TEMP TABLE tmp_literal_enum_checks AS
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype = 'c'
  AND n.nspname IN ('public', 'qa')
  AND c.relkind IN ('r', 'p')
  AND c.relispartition = false
  -- Exclude extension/system tables we do not own.
  AND c.relname NOT IN ('spatial_ref_sys')
  -- Enum-like literal allowlists only; avoid false positives such as POSITION('@' IN email).
  AND public.constraint_has_literal_allowlist_v1(pg_get_constraintdef(con.oid));

SELECT diag(format('Literal-list CHECK constraint: %s.%s %s :: %s', schema_name, table_name, constraint_name, definition))
FROM tmp_literal_enum_checks;

SELECT is(
  (SELECT COUNT(*)::INT FROM tmp_literal_enum_checks),
  0,
  'No literal-list enum CHECK constraints exist in public/qa (use lookup contracts instead)'
);

SELECT finish();

ROLLBACK;
