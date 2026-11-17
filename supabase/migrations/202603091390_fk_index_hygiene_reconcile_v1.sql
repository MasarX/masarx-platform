-- Plan: PLAN-202603-shared-mapping-studio / Step: S95
-- Migration: Reconcile FK hygiene dynamically across public/qa schemas
--
-- Purpose:
--   - Shared/dev can accumulate FK index drift that a clean local reset will not show.
--   - The enterprise FK hygiene contract requires a full supporting index for every
--     non-partition foreign key in public/qa.
--   - Repair this dynamically instead of hardcoding another table-specific list.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091390_fk_index_hygiene_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
    v_fk RECORD;
    v_index_columns TEXT;
    v_index_name_base TEXT;
    v_index_name TEXT;
    v_created_count INTEGER := 0;
BEGIN
    FOR v_fk IN
        WITH fk_cols AS (
            SELECT
                n.nspname AS table_schema,
                c.relname AS table_name,
                c.oid AS table_oid,
                con.conname AS constraint_name,
                array_agg(a.attname ORDER BY k.ord) AS columns
            FROM pg_constraint con
            JOIN pg_class c
              ON c.oid = con.conrelid
            JOIN pg_namespace n
              ON n.oid = c.relnamespace
            JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
              ON true
            JOIN pg_attribute a
              ON a.attrelid = con.conrelid
             AND a.attnum = k.attnum
            WHERE con.contype = 'f'
              AND n.nspname IN ('public', 'qa')
              AND c.relispartition = FALSE
            GROUP BY 1, 2, 3, 4
        ),
        idx_cols AS (
            SELECT
                i.indrelid AS table_oid,
                array_agg(a.attname ORDER BY x.ord) AS columns,
                (i.indpred IS NULL) AS is_full
            FROM pg_index i
            JOIN pg_class c
              ON c.oid = i.indrelid
            JOIN pg_namespace n
              ON n.oid = c.relnamespace
            JOIN unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord)
              ON true
            JOIN pg_attribute a
              ON a.attrelid = c.oid
             AND a.attnum = x.attnum
            WHERE n.nspname IN ('public', 'qa')
              AND c.relispartition = FALSE
              AND x.attnum > 0
            GROUP BY 1, i.indexrelid, i.indpred
        )
        SELECT
            fk.table_schema,
            fk.table_name,
            fk.constraint_name,
            fk.columns
        FROM fk_cols fk
        WHERE NOT EXISTS (
            SELECT 1
            FROM idx_cols ic
            WHERE ic.table_oid = fk.table_oid
              AND ic.is_full = TRUE
              AND ic.columns[1:array_length(fk.columns, 1)] = fk.columns
        )
        ORDER BY fk.table_schema, fk.table_name, fk.constraint_name
    LOOP
        SELECT string_agg(format('%I', column_name), ', ')
          INTO v_index_columns
          FROM unnest(v_fk.columns) AS column_name;

        v_index_name_base :=
            format(
                'idx_%s_%s_%s',
                v_fk.table_schema,
                v_fk.table_name,
                array_to_string(v_fk.columns, '_')
            );
        v_index_name := lower(regexp_replace(v_index_name_base, '[^a-zA-Z0-9_]+', '_', 'g'));

        IF length(v_index_name) > 54 THEN
            v_index_name := format(
                '%s_%s',
                left(v_index_name, 54),
                substring(md5(v_index_name_base) FROM 1 FOR 8)
            );
        END IF;

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
            v_index_name,
            v_fk.table_schema,
            v_fk.table_name,
            v_index_columns
        );
        v_created_count := v_created_count + 1;
    END LOOP;

    RAISE NOTICE 'fk_index_hygiene_reconcile_v1 created % missing full FK index(es)', v_created_count;
END
$$;

SELECT pg_advisory_unlock(hashtext('202603091390_fk_index_hygiene_reconcile_v1'));
COMMIT;
