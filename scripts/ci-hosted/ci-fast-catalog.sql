SET search_path = pg_catalog;
WITH namespaces AS (
  SELECT oid, nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
), objects AS (
  SELECT 'pg_class' AS kind, c.oid, nspname, relname AS name, NULL::text AS body
  FROM pg_class c JOIN namespaces n ON n.oid = relnamespace
  UNION ALL
  SELECT 'pg_proc', p.oid, nspname, proname, prosrc
  FROM pg_proc p JOIN namespaces n ON n.oid = pronamespace
  UNION ALL
  SELECT 'pg_type', t.oid, nspname, typname, NULL
  FROM pg_type t JOIN namespaces n ON n.oid = typnamespace
), edges AS (
  SELECT refclassid::regclass::text AS source_kind, refobjid AS source_oid,
    classid::regclass::text AS target_kind, objid AS target_oid
  FROM pg_depend
  UNION
  SELECT 'pg_rewrite', oid, 'pg_class', ev_class FROM pg_rewrite
  UNION
  SELECT 'pg_trigger', oid, 'pg_class', tgrelid FROM pg_trigger
  UNION
  SELECT 'pg_constraint', oid, 'pg_class', conrelid FROM pg_constraint WHERE conrelid <> 0
  UNION
  SELECT 'pg_policy', oid, 'pg_class', polrelid FROM pg_policy
)
SELECT jsonb_build_object(
  'objects', (SELECT jsonb_agg(jsonb_build_array(kind || ':' || oid, nspname, name, body)) FROM objects),
  'edges', (SELECT jsonb_agg(jsonb_build_array(source_kind || ':' || source_oid, target_kind || ':' || target_oid)) FROM edges)
);
