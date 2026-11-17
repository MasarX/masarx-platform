-- Migration: pgtap col_is_fk compatibility shim
-- Purpose:
--   Provide a schema-qualified col_is_fk(table, column, referenced_table, description)
--   helper under the pgtap schema so existing pgTAP tests that assume the
--   upstream signature can correctly detect foreign key constraints in the
--   current Supabase extension layout (functions live under the extensions
--   schema).

BEGIN;

CREATE SCHEMA IF NOT EXISTS pgtap;

CREATE OR REPLACE FUNCTION pgtap.col_is_fk(_table name, _column name, _references_table name, _description text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  _schema name := 'public';
  _has_fk boolean;
  _cols text[];
BEGIN
  -- Check for at least one FK from (_schema._table._column) to the referenced table.
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage fk
        ON rc.constraint_name = fk.constraint_name
       AND rc.constraint_schema = fk.constraint_schema
      JOIN information_schema.key_column_usage pk
        ON rc.unique_constraint_name = pk.constraint_name
       AND rc.unique_constraint_schema = pk.constraint_schema
       AND pk.ordinal_position = fk.position_in_unique_constraint
     WHERE fk.table_schema = _schema
       AND fk.table_name = _table
       AND fk.column_name = _column
       AND pk.table_schema = _schema
       AND pk.table_name = _references_table
  ) INTO _has_fk;

  IF _has_fk THEN
    RETURN extensions.ok(true, _description);
  END IF;

  -- If there are other FKs on this table, surface them for diagnostics.
  SELECT ARRAY(
    SELECT DISTINCT fk.column_name
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage fk
        ON rc.constraint_name = fk.constraint_name
       AND rc.constraint_schema = fk.constraint_schema
     WHERE fk.table_schema = _schema
       AND fk.table_name = _table
     ORDER BY fk.column_name
  ) INTO _cols;

  IF _cols[1] IS NOT NULL THEN
    RETURN extensions.fail(_description)
           || E'\n'
           || extensions.diag(
                '    Table '
                || quote_ident(_schema) || '.' || quote_ident(_table)
                || E' has foreign key constraints on these columns:\n        '
                || array_to_string(_cols, E'\n        ')
              );
  END IF;

  RETURN extensions.fail(_description)
         || E'\n'
         || extensions.diag(
              '    Table '
              || quote_ident(_schema) || '.' || quote_ident(_table)
              || ' has no foreign key columns'
            );
END;
$$;

COMMIT;

