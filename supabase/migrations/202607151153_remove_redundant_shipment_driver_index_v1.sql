-- Remove the obsolete invalid partitioned root index left by
-- 202603061010_shipment_operation_handlers_v1.sql.
--
-- The recursive replacement idx_shipments_driver_user_id_fk must be complete
-- and healthy before the redundant root is removed. Every catalog assertion
-- fails closed so drift cannot turn this cleanup into a name-only deletion.

BEGIN;

SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '5s';

SELECT pg_advisory_xact_lock(
  hashtext('202607151153_remove_redundant_shipment_driver_index_v1')
);

LOCK TABLE ONLY public.shipments IN ACCESS EXCLUSIVE MODE;

DO $migration$
DECLARE
  v_shipments_oid OID := to_regclass('public.shipments');
  v_replacement_oid OID := to_regclass('public.idx_shipments_driver_user_id_fk');
  v_obsolete_oid OID := to_regclass('public.idx_shipments_driver_user_id');
  v_driver_attnum SMALLINT;
  v_uuid_btree_opclass_oid OID;
  v_unexpected_dependencies TEXT;
BEGIN
  IF v_shipments_oid IS NULL THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: public.shipments is missing';
  END IF;

  SELECT attribute.attnum
    INTO v_driver_attnum
    FROM pg_catalog.pg_attribute attribute
   WHERE attribute.attrelid = v_shipments_oid
     AND attribute.attname = 'driver_user_id'
     AND attribute.atttypid = 'uuid'::regtype
     AND NOT attribute.attisdropped;

  IF v_driver_attnum IS NULL THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: shipments.driver_user_id contract is missing';
  END IF;

  SELECT opclass.oid
    INTO v_uuid_btree_opclass_oid
    FROM pg_catalog.pg_opclass opclass
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = opclass.opcmethod
    JOIN pg_catalog.pg_namespace opclass_namespace
      ON opclass_namespace.oid = opclass.opcnamespace
   WHERE opclass_namespace.nspname = 'pg_catalog'
     AND opclass.opcname = 'uuid_ops'
     AND access_method.amname = 'btree';

  IF v_uuid_btree_opclass_oid IS NULL THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: pg_catalog btree uuid_ops is missing';
  END IF;

  IF v_replacement_oid IS NULL THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: replacement index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index index_row
      JOIN pg_catalog.pg_class index_class
        ON index_class.oid = index_row.indexrelid
      JOIN pg_catalog.pg_class table_class
        ON table_class.oid = index_row.indrelid
      JOIN pg_catalog.pg_namespace table_namespace
        ON table_namespace.oid = table_class.relnamespace
      JOIN pg_catalog.pg_am access_method
        ON access_method.oid = index_class.relam
      JOIN pg_catalog.pg_attribute key_attribute
        ON key_attribute.attrelid = index_row.indrelid
       AND key_attribute.attnum = index_row.indkey[0]
      JOIN pg_catalog.pg_opclass key_opclass
        ON key_opclass.oid = index_row.indclass[0]
     WHERE index_row.indexrelid = v_replacement_oid
       AND index_row.indrelid = v_shipments_oid
       AND table_namespace.nspname = 'public'
       AND table_class.relname = 'shipments'
       AND table_class.relkind = 'p'
       AND index_class.relname = 'idx_shipments_driver_user_id_fk'
       AND index_class.relkind = 'I'
       AND access_method.amname = 'btree'
       AND index_row.indisvalid
       AND index_row.indisready
       AND index_row.indislive
       AND NOT index_row.indisunique
       AND NOT index_row.indisprimary
       AND NOT index_row.indisexclusion
       AND NOT index_row.indisclustered
       AND NOT index_row.indisreplident
       AND NOT index_row.indnullsnotdistinct
       AND index_row.indnkeyatts = 1
       AND index_row.indnatts = 1
       AND index_row.indexprs IS NULL
       AND index_row.indpred IS NULL
       AND key_attribute.attname = 'driver_user_id'
       AND key_attribute.atttypid = 'uuid'::regtype
       AND key_opclass.oid = v_uuid_btree_opclass_oid
       AND index_row.indcollation[0] = 0
       AND index_row.indoption[0] = 0
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: replacement root contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint constraint_row
     WHERE constraint_row.conindid = v_replacement_oid
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: replacement root is constraint-backed';
  END IF;

  IF EXISTS (
    WITH RECURSIVE
    table_tree(table_oid) AS (
      SELECT v_shipments_oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_catalog.pg_inherits inheritance
        JOIN table_tree parent
          ON parent.table_oid = inheritance.inhparent
    ),
    index_tree(index_oid) AS (
      SELECT v_replacement_oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_catalog.pg_inherits inheritance
        JOIN index_tree parent
          ON parent.index_oid = inheritance.inhparent
    ),
    mapped_indexes AS (
      SELECT index_tree.index_oid, index_row.indrelid AS table_oid
        FROM index_tree
        JOIN pg_catalog.pg_index index_row
          ON index_row.indexrelid = index_tree.index_oid
    )
    SELECT 1
      FROM table_tree
      LEFT JOIN mapped_indexes
        ON mapped_indexes.table_oid = table_tree.table_oid
     GROUP BY table_tree.table_oid
    HAVING count(mapped_indexes.index_oid) <> 1
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: replacement partition coverage is incomplete';
  END IF;

  IF EXISTS (
    WITH RECURSIVE
    table_tree(table_oid) AS (
      SELECT v_shipments_oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_catalog.pg_inherits inheritance
        JOIN table_tree parent
          ON parent.table_oid = inheritance.inhparent
    ),
    index_tree(index_oid) AS (
      SELECT v_replacement_oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_catalog.pg_inherits inheritance
        JOIN index_tree parent
          ON parent.index_oid = inheritance.inhparent
    )
    SELECT 1
      FROM index_tree
      JOIN pg_catalog.pg_index index_row
        ON index_row.indexrelid = index_tree.index_oid
     WHERE index_row.indrelid NOT IN (SELECT table_oid FROM table_tree)
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: replacement index tree has unexpected attachments';
  END IF;

  IF EXISTS (
    WITH RECURSIVE index_tree(index_oid) AS (
      SELECT v_replacement_oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_catalog.pg_inherits inheritance
        JOIN index_tree parent
          ON parent.index_oid = inheritance.inhparent
    )
    SELECT 1
      FROM index_tree
      JOIN pg_catalog.pg_index index_row
        ON index_row.indexrelid = index_tree.index_oid
      JOIN pg_catalog.pg_class index_class
        ON index_class.oid = index_row.indexrelid
      JOIN pg_catalog.pg_class table_class
        ON table_class.oid = index_row.indrelid
      JOIN pg_catalog.pg_am access_method
        ON access_method.oid = index_class.relam
      JOIN pg_catalog.pg_attribute key_attribute
        ON key_attribute.attrelid = index_row.indrelid
       AND key_attribute.attnum = index_row.indkey[0]
      JOIN pg_catalog.pg_opclass key_opclass
        ON key_opclass.oid = index_row.indclass[0]
     WHERE NOT (
       index_row.indisvalid
       AND index_row.indisready
       AND index_row.indislive
       AND NOT index_row.indisunique
       AND NOT index_row.indisprimary
       AND NOT index_row.indisexclusion
       AND NOT index_row.indisclustered
       AND NOT index_row.indisreplident
       AND NOT index_row.indnullsnotdistinct
       AND index_row.indnkeyatts = 1
       AND index_row.indnatts = 1
       AND index_row.indexprs IS NULL
       AND index_row.indpred IS NULL
       AND access_method.amname = 'btree'
       AND key_attribute.attname = 'driver_user_id'
       AND key_attribute.atttypid = 'uuid'::regtype
       AND key_opclass.oid = v_uuid_btree_opclass_oid
       AND index_row.indcollation[0] = 0
       AND index_row.indoption[0] = 0
       AND (
         (table_class.relkind = 'p' AND index_class.relkind = 'I')
         OR (table_class.relkind = 'r' AND index_class.relkind = 'i')
       )
     )
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: replacement partition contract drifted';
  END IF;

  IF EXISTS (
    WITH RECURSIVE index_tree(index_oid) AS (
      SELECT v_replacement_oid
      UNION ALL
      SELECT inheritance.inhrelid
        FROM pg_catalog.pg_inherits inheritance
        JOIN index_tree parent
          ON parent.index_oid = inheritance.inhparent
    )
    SELECT 1
      FROM index_tree
      JOIN pg_catalog.pg_constraint constraint_row
        ON constraint_row.conindid = index_tree.index_oid
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: replacement index tree is constraint-backed';
  END IF;

  -- An already-absent obsolete root is an accepted idempotent state, but only
  -- after the recursive replacement has passed every assertion above.
  IF v_obsolete_oid IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index index_row
      JOIN pg_catalog.pg_class index_class
        ON index_class.oid = index_row.indexrelid
      JOIN pg_catalog.pg_class table_class
        ON table_class.oid = index_row.indrelid
      JOIN pg_catalog.pg_namespace table_namespace
        ON table_namespace.oid = table_class.relnamespace
      JOIN pg_catalog.pg_am access_method
        ON access_method.oid = index_class.relam
      JOIN pg_catalog.pg_attribute key_attribute
        ON key_attribute.attrelid = index_row.indrelid
       AND key_attribute.attnum = index_row.indkey[0]
      JOIN pg_catalog.pg_opclass key_opclass
        ON key_opclass.oid = index_row.indclass[0]
     WHERE index_row.indexrelid = v_obsolete_oid
       AND index_row.indrelid = v_shipments_oid
       AND table_namespace.nspname = 'public'
       AND table_class.relname = 'shipments'
       AND table_class.relkind = 'p'
       AND index_class.relname = 'idx_shipments_driver_user_id'
       AND index_class.relkind = 'I'
       AND access_method.amname = 'btree'
       AND NOT index_row.indisvalid
       AND index_row.indisready
       AND index_row.indislive
       AND NOT index_row.indisunique
       AND NOT index_row.indisprimary
       AND NOT index_row.indisexclusion
       AND NOT index_row.indisclustered
       AND NOT index_row.indisreplident
       AND NOT index_row.indnullsnotdistinct
       AND index_row.indnkeyatts = 1
       AND index_row.indnatts = 1
       AND index_row.indexprs IS NULL
       AND key_attribute.attname = 'driver_user_id'
       AND key_attribute.atttypid = 'uuid'::regtype
       AND key_opclass.oid = v_uuid_btree_opclass_oid
       AND index_row.indcollation[0] = 0
       AND index_row.indoption[0] = 0
       AND regexp_replace(
         lower(COALESCE(pg_get_expr(index_row.indpred, index_row.indrelid), '')),
         '["()[:space:]]',
         '',
         'g'
       ) = 'driver_user_idisnotnull'
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: obsolete root contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint constraint_row
     WHERE constraint_row.conindid = v_obsolete_oid
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: obsolete root is constraint-backed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_inherits inheritance
     WHERE inheritance.inhparent = v_obsolete_oid
        OR inheritance.inhrelid = v_obsolete_oid
  ) THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: obsolete root has index inheritance';
  END IF;

  SELECT string_agg(
           dependency.deptype::text || ':' ||
           pg_catalog.pg_describe_object(
             dependency.refclassid,
             dependency.refobjid,
             dependency.refobjsubid
           ),
           ', '
           ORDER BY dependency.deptype, dependency.refclassid, dependency.refobjid
         )
    INTO v_unexpected_dependencies
    FROM pg_catalog.pg_depend dependency
   WHERE dependency.classid = 'pg_class'::regclass
     AND dependency.objid = v_obsolete_oid
     AND NOT (
       (
         dependency.deptype = 'a'
         AND dependency.refclassid = 'pg_class'::regclass
         AND dependency.refobjid = v_shipments_oid
         AND dependency.refobjsubid = v_driver_attnum
       )
       OR (
         dependency.deptype = 'n'
         AND dependency.refclassid = 'pg_opclass'::regclass
         AND dependency.refobjid = v_uuid_btree_opclass_oid
         AND dependency.refobjsubid = 0
       )
     );

  IF v_unexpected_dependencies IS NOT NULL THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: obsolete root has unexpected dependencies: %',
      v_unexpected_dependencies;
  END IF;

  SELECT string_agg(
           dependency.deptype::text || ':' ||
           pg_catalog.pg_describe_object(
             dependency.classid,
             dependency.objid,
             dependency.objsubid
           ),
           ', '
           ORDER BY dependency.deptype, dependency.classid, dependency.objid
         )
    INTO v_unexpected_dependencies
    FROM pg_catalog.pg_depend dependency
   WHERE dependency.refclassid = 'pg_class'::regclass
     AND dependency.refobjid = v_obsolete_oid;

  IF v_unexpected_dependencies IS NOT NULL THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: obsolete root has unexpected dependents: %',
      v_unexpected_dependencies;
  END IF;

  EXECUTE 'DROP INDEX public.idx_shipments_driver_user_id RESTRICT';

  IF to_regclass('public.idx_shipments_driver_user_id') IS NOT NULL THEN
    RAISE EXCEPTION
      'remove_redundant_shipment_driver_index_v1: obsolete root still exists after drop';
  END IF;
END;
$migration$;

COMMIT;
