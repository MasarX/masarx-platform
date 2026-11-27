BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog;

-- Only evaluate the reviewed planner, with its PUBLIC EXECUTE predicate projected onto the closure targets.
WITH planner AS (
  SELECT replace(prosrc, E'\r\n', E'\n') AS body,
    $acl$WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')$acl$ AS seam,
    $inheritance$SELECT operation,i.inhparent,operation,i.inhrelid FROM pg_inherits i$inheritance$ AS inheritance_seam
  FROM pg_proc
  WHERE oid = 'public.ui_rpc_executor_privilege_plan_v1()'::regprocedure
    AND proowner = current_user::regrole::oid AND prosecdef AND provolatile = 's'
    AND proconfig = ARRAY['search_path=public, extensions, pg_temp']
), grant_targets AS (
  SELECT array_agg(DISTINCT to_regprocedure(signature)::oid) AS oids
  FROM regexp_split_to_table(:'grants', E'\n') AS targets(signature)
), revoke_targets AS (
  SELECT array_agg(DISTINCT to_regprocedure(signature)::oid) AS oids
  FROM regexp_split_to_table(:'revokes', E'\n') AS targets(signature)
)
SELECT COALESCE((SELECT
    encode(sha256(convert_to(body, 'UTF8')), 'hex') = '98b2df1a98d7cdb61acaab6a4e0027ab8e87411d8e0252fadba7a79029a8d2e0'
    AND length(body) - length(replace(body, seam, '')) = length(seam)
    AND length(body) - length(replace(body, inheritance_seam, '')) = length(inheritance_seam)
    FROM planner), false)
    AND cardinality(g.oids) = 46 AND array_position(g.oids, NULL) IS NULL
    AND cardinality(r.oids) = 454 AND array_position(r.oids, NULL) IS NULL
    AND r.oids @> g.oids AS diagnostic_inputs_ok,
  -- The stored body ends with ';', which cannot sit inside the projected_after CTE; the hash above stays on the raw body.
  (SELECT regexp_replace(replace(body, seam, format(
    $acl$WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE' AND f.oid <> ALL (%L::oid[]))$acl$, r.oids)), ';\s*$', '')
   FROM planner) AS projected_sql,
  -- Keep legacy inheritance and isolate the effect of descending into declarative partitions for writes.
  (SELECT regexp_replace(replace(body, inheritance_seam, inheritance_seam ||
    ' JOIN pg_class child ON child.oid = i.inhrelid AND NOT child.relispartition'), ';\s*$', '')
   FROM planner) AS without_partition_writes_sql,
  g.oids AS grant_oids, r.oids AS revoke_oids
FROM grant_targets g CROSS JOIN revoke_targets r
\gset

\if :diagnostic_inputs_ok
SELECT 'closure_recorded=' || (EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261126163709'))::text
  || ' closure_receipt=' || (EXISTS (
    SELECT 1 FROM public.marketplace_review_readback_state_v1 WHERE key = 'public_execute_closure_extension_v1'))::text
  || ' predecessor_seal_valid=' || COALESCE(
    obj_description('public.marketplace_review_readback_state_v1'::regclass, 'pg_class') =
    (SELECT 'marketplace_review_readback_state_v1:sha256:' ||
      encode(sha256(convert_to(jsonb_object_agg(key, value ORDER BY key)::text, 'UTF8')), 'hex')
     FROM public.marketplace_review_readback_state_v1), false)::text
  || ' public_targets=' || count(DISTINCT p.oid) FILTER (
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  || ' direct_executor_targets=' || count(DISTINCT p.oid) FILTER (
    WHERE a.grantee = 'ui_rpc_executor'::regrole::oid AND a.privilege_type = 'EXECUTE'
      AND p.oid = ANY (:'grant_oids'::oid[]))
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
WHERE p.oid = ANY (:'revoke_oids'::oid[]);

-- Match the search path in the original planner when evaluating the projection.
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
WITH prior AS (
  SELECT p.* FROM public.marketplace_review_readback_state_v1 r
  CROSS JOIN LATERAL jsonb_to_recordset(r.value) AS p(object_kind text, object_id oid, privilege text, column_name text)
  WHERE r.key = 'plan_after'
), actual_before AS (
  SELECT * FROM public.ui_rpc_executor_privilege_plan_v1()
), planned_grants AS (
  SELECT 'function'::text AS object_kind, oid AS object_id, 'EXECUTE'::text AS privilege, NULL::text AS column_name
  FROM unnest(:'grant_oids'::oid[]) AS added(oid)
), expected_after AS (
  SELECT * FROM prior
  UNION
  SELECT * FROM planned_grants
), projected_after AS (
  :projected_sql
), closure_added AS (
  SELECT * FROM projected_after EXCEPT SELECT * FROM prior
), closure_removed AS (
  SELECT * FROM prior EXCEPT SELECT * FROM projected_after
), closure_invalid AS (
  SELECT a.* FROM closure_added a
  WHERE a.object_kind <> 'function' OR a.privilege <> 'EXECUTE' OR a.column_name IS NOT NULL
    OR (a.object_id <> ALL (:'grant_oids'::oid[]) AND NOT EXISTS (
      SELECT 1 FROM pg_proc f CROSS JOIN LATERAL aclexplode(f.proacl) acl
      WHERE f.oid = a.object_id AND acl.grantee = 'ui_rpc_executor'::regrole::oid AND acl.privilege_type = 'EXECUTE'
    ))
), before_extra AS (
  SELECT * FROM actual_before EXCEPT SELECT * FROM prior
), projected_extra AS (
  SELECT * FROM projected_after EXCEPT SELECT * FROM expected_after
), unexplained_selects AS (
  SELECT * FROM before_extra INTERSECT SELECT * FROM projected_extra INTERSECT SELECT * FROM closure_invalid
), without_partition_writes AS (
  :without_partition_writes_sql
)
SELECT 'closure_added=' || (SELECT count(*) FROM closure_added)
  || ' closure_removed=' || (SELECT count(*) FROM closure_removed)
  || ' closure_invalid=' || (SELECT count(*) FROM closure_invalid)
  || ' before_extra=' || (SELECT count(*) FROM before_extra)
  || ' projected_extra=' || (SELECT count(*) FROM projected_extra)
UNION ALL
SELECT concat_ws(' ',
  'relkind=' || c.relkind::text,
  'relispartition=' || c.relispartition::text,
  'maintenance_name_match=' || COALESCE(cfg.partition_strategy IN ('RANGE', 'HASH+RANGE')
    AND c.relnamespace = 'public'::regnamespace
    AND c.relname::text = (CASE WHEN cfg.partition_interval = 'weekly'
      THEN public.generate_partition_name_range_weekly(cfg.table_name, bound.parts[1]::timestamptz)
      ELSE public.generate_partition_name_range_monthly(cfg.table_name, bound.parts[1]::timestamptz)
    END || CASE WHEN cfg.partition_strategy = 'HASH+RANGE'
      THEN '_p' || COALESCE((regexp_match(parent.relname::text, '.*_p([0-9]+)$'))[1], '0')::int::text
      ELSE '' END), false)::text,
  'inherited_write_required=' || (NOT EXISTS (
    SELECT 1 FROM without_partition_writes p
    WHERE p.object_kind = 'relation' AND p.object_id = c.oid AND p.privilege = 'SELECT'
  ))::text,
  'executor_select=' || has_table_privilege('ui_rpc_executor', c.oid, 'SELECT')::text,
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM before_extra p WHERE p.object_kind = 'relation' AND p.object_id = parent.oid
  ) THEN substring(parent.relname::text FROM '^[a-zA-Z_][a-zA-Z_0-9]*$') END)
FROM unexplained_selects d
JOIN pg_class c ON c.oid = d.object_id
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class parent ON parent.oid = i.inhparent
LEFT JOIN pg_class root ON root.oid = pg_partition_root(c.oid)
LEFT JOIN public.partitioning_config cfg ON cfg.table_name = root.relname::text
LEFT JOIN LATERAL regexp_match(pg_get_expr(c.relpartbound, c.oid),
  $bound$^FOR VALUES FROM \('([0-9-]+ [0-9:]+[+]00)'\) TO \($bound$) AS bound(parts) ON c.relispartition
WHERE d.object_kind = 'relation' AND d.privilege = 'SELECT';
ROLLBACK;
\echo diagnostic_status=complete
\else
ROLLBACK;
\echo diagnostic_status=input-mismatch
\endif
