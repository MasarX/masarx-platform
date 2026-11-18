-- B07: obsolete shipment driver index cleanup contract.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT is(
  to_regclass('public.idx_shipments_driver_user_id'),
  NULL::regclass,
  'obsolete invalid shipment driver index is absent'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_index index_row
      JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
      JOIN pg_class table_class ON table_class.oid = index_row.indrelid
      JOIN pg_am access_method ON access_method.oid = index_class.relam
      JOIN pg_attribute key_attribute
        ON key_attribute.attrelid = index_row.indrelid
       AND key_attribute.attnum = index_row.indkey[0]
      JOIN pg_opclass key_opclass ON key_opclass.oid = index_row.indclass[0]
     WHERE index_row.indexrelid = to_regclass('public.idx_shipments_driver_user_id_fk')
       AND index_row.indrelid = to_regclass('public.shipments')
       AND index_class.relkind = 'I'
       AND table_class.relkind = 'p'
       AND access_method.amname = 'btree'
       AND index_row.indisvalid
       AND index_row.indisready
       AND index_row.indislive
       AND NOT index_row.indisunique
       AND NOT index_row.indisprimary
       AND NOT index_row.indisclustered
       AND NOT index_row.indisreplident
       AND index_row.indnkeyatts = 1
       AND index_row.indnatts = 1
       AND index_row.indexprs IS NULL
       AND index_row.indpred IS NULL
       AND key_attribute.attname = 'driver_user_id'
       AND key_attribute.atttypid = 'uuid'::regtype
       AND key_opclass.opcname = 'uuid_ops'
       AND key_opclass.oid = (
         SELECT opclass.oid
           FROM pg_opclass opclass
           JOIN pg_am method ON method.oid = opclass.opcmethod
           JOIN pg_namespace namespace ON namespace.oid = opclass.opcnamespace
          WHERE namespace.nspname = 'pg_catalog'
            AND opclass.opcname = 'uuid_ops'
            AND method.amname = 'btree'
       )
       AND index_row.indcollation[0] = 0
       AND index_row.indoption[0] = 0
  ),
  'replacement shipment driver root index has the exact healthy contract'
);

SELECT is(
  (
    WITH RECURSIVE
    table_tree(table_oid) AS (
      SELECT to_regclass('public.shipments')::oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_inherits inheritance
        JOIN table_tree parent ON parent.table_oid = inheritance.inhparent
    ),
    index_tree(index_oid) AS (
      SELECT to_regclass('public.idx_shipments_driver_user_id_fk')::oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_inherits inheritance
        JOIN index_tree parent ON parent.index_oid = inheritance.inhparent
    ),
    mapped_indexes AS (
      SELECT index_tree.index_oid, index_row.indrelid AS table_oid
        FROM index_tree
        JOIN pg_index index_row ON index_row.indexrelid = index_tree.index_oid
    )
    SELECT count(*)::integer
      FROM (
        SELECT table_tree.table_oid
          FROM table_tree
          LEFT JOIN mapped_indexes
            ON mapped_indexes.table_oid = table_tree.table_oid
         GROUP BY table_tree.table_oid
        HAVING count(mapped_indexes.index_oid) <> 1
      ) incomplete
  ),
  0,
  'replacement index tree covers every shipment partition exactly once'
);

SELECT is(
  (
    WITH RECURSIVE index_tree(index_oid) AS (
      SELECT to_regclass('public.idx_shipments_driver_user_id_fk')::oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_inherits inheritance
        JOIN index_tree parent ON parent.index_oid = inheritance.inhparent
    )
    SELECT count(*)::integer
      FROM index_tree
      JOIN pg_index index_row ON index_row.indexrelid = index_tree.index_oid
     WHERE NOT (
       index_row.indisvalid
       AND index_row.indisready
       AND index_row.indislive
       AND NOT index_row.indisclustered
       AND NOT index_row.indisreplident
       AND index_row.indpred IS NULL
       AND index_row.indexprs IS NULL
     )
  ),
  0,
  'every replacement index partition is valid, ready, live, and nonpartial'
);

SELECT is(
  (
    SELECT count(*)::integer
      FROM pg_index index_row
      JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
      JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
     WHERE index_namespace.nspname IN ('public', 'qa')
       AND NOT index_row.indisvalid
  ),
  0,
  'no invalid indexes remain in application schemas'
);

SELECT * FROM finish();

ROLLBACK;
