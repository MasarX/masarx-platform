-- Test: canonical timestamp compatibility columns + updated_at trigger presence
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

SELECT ok(
  NOT EXISTS (
    SELECT 1
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
      AND c.column_name = 'timestamp'
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c2
        WHERE c2.table_schema = c.table_schema
          AND c2.table_name = c.table_name
          AND c2.column_name = 'created_at'
      )
  ),
  'All base tables with `timestamp` expose canonical `created_at`'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
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
      AND c.column_name = 'last_updated'
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c2
        WHERE c2.table_schema = c.table_schema
          AND c2.table_name = c.table_name
          AND c2.column_name = 'updated_at'
      )
  ),
  'All base tables with `last_updated` expose canonical `updated_at`'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
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
      AND c.column_name = 'updated_at'
      AND COALESCE(c.is_generated, 'NEVER') = 'NEVER'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger tg
        WHERE tg.tgrelid = format('public.%I', c.table_name)::regclass
          AND tg.tgname = left(format('trg_%s_set_updated_at', c.table_name), 63)
      )
  ),
  'All base tables with physical `updated_at` have standard updated_at trigger'
);

SELECT finish();
ROLLBACK;
