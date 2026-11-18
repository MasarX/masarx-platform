-- Read-only, partition-aware inventory for shipment identifier online indexes.
-- Run before, during, and after scripts/ops/db/run-online-index-phase.js.
-- It reports every leaf, active build, blocker, exact catalog definition,
-- partitioned-index attachment, topology drift, and durable same-SHA state.

WITH roots(relation_name, root_index_name) AS (
  VALUES
    ('public.workflow_runs'::regclass, 'idx_workflow_runs_triggered_by_request_id_not_null'::text),
    ('public.decision_log'::regclass, 'idx_decision_log_org_correlation_not_null'::text),
    ('public.domain_events'::regclass, 'idx_domain_events_org_correlation_resource_not_null'::text)
), topology AS (
  SELECT
    r.relation_name AS root_relation,
    r.root_index_name,
    COALESCE(t.relid, r.relation_name::oid) AS relid,
    t.parentrelid,
    COALESCE(t.isleaf, true) AS isleaf,
    COALESCE(t.level, 0) AS level
  FROM roots r
  LEFT JOIN LATERAL pg_partition_tree(r.relation_name) t ON true
)
SELECT
  root_relation,
  relid::regclass AS relation,
  parentrelid::regclass AS parent_relation,
  level,
  isleaf,
  c.reltuples::bigint AS estimated_rows,
  pg_relation_size(relid) AS table_bytes,
  pg_indexes_size(relid) AS index_bytes,
  pg_total_relation_size(relid) AS total_bytes,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM topology
JOIN pg_class c ON c.oid = relid
ORDER BY root_relation::text, level, relid::regclass::text;

WITH roots(relation_name) AS (
  VALUES
    ('public.workflow_runs'::regclass),
    ('public.decision_log'::regclass),
    ('public.domain_events'::regclass)
), topology AS (
  SELECT
    r.relation_name AS root_relation,
    COALESCE(t.relid, r.relation_name::oid) AS relid,
    t.parentrelid,
    COALESCE(t.isleaf, true) AS isleaf,
    COALESCE(t.level, 0) AS level
  FROM roots r
  LEFT JOIN LATERAL pg_partition_tree(r.relation_name) t ON true
)
SELECT
  root_relation,
  count(*) AS relation_count,
  count(*) FILTER (WHERE isleaf) AS leaf_count,
  md5(string_agg(
    concat_ws(':', relid::text, COALESCE(parentrelid::text, ''), level::text, isleaf::text),
    ',' ORDER BY level, relid
  )) AS diagnostic_topology_md5
FROM topology
GROUP BY root_relation
ORDER BY root_relation::text;

WITH roots(relation_name) AS (
  VALUES
    ('public.workflow_runs'::regclass),
    ('public.decision_log'::regclass),
    ('public.domain_events'::regclass)
), topology AS (
  SELECT COALESCE(t.relid, r.relation_name::oid) AS relid
  FROM roots r
  LEFT JOIN LATERAL pg_partition_tree(r.relation_name) t ON true
)
SELECT
  p.pid,
  p.relid::regclass AS relation,
  p.index_relid::regclass AS index_relation,
  p.command,
  p.phase,
  p.lockers_done,
  p.lockers_total,
  p.blocks_done,
  p.blocks_total,
  p.tuples_done,
  p.tuples_total,
  a.wait_event_type,
  a.wait_event,
  cardinality(pg_blocking_pids(p.pid)) AS blocker_count,
  pg_blocking_pids(p.pid) AS blocker_pids
FROM pg_stat_progress_create_index p
JOIN topology t ON t.relid = p.relid
LEFT JOIN pg_stat_activity a ON a.pid = p.pid
ORDER BY p.pid;

WITH watched AS (
  SELECT COALESCE(t.relid, root.relation_name::oid) AS relid
  FROM unnest(ARRAY[
    'public.workflow_runs'::regclass,
    'public.decision_log'::regclass,
    'public.domain_events'::regclass,
    'public.outbound_calls'::regclass
  ]) AS root(relation_name)
  LEFT JOIN LATERAL pg_partition_tree(root.relation_name) t ON true
)
SELECT
  l.pid,
  l.relation::regclass AS relation,
  l.mode,
  l.granted,
  a.state,
  a.wait_event_type,
  a.wait_event,
  cardinality(pg_blocking_pids(l.pid)) AS blocker_count,
  pg_blocking_pids(l.pid) AS blocker_pids,
  left(a.query, 300) AS query_sample
FROM pg_locks l
JOIN watched w ON w.relid = l.relation
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
ORDER BY l.relation::regclass::text, l.granted, l.pid;

WITH roots(
  relation_name,
  root_index_name,
  expected_columns,
  expected_opclasses,
  expected_collations,
  expected_predicate
) AS (
  VALUES
    (
      'public.workflow_runs'::regclass,
      'idx_workflow_runs_triggered_by_request_id_not_null'::text,
      ARRAY['triggered_by_request_id']::text[],
      ARRAY['uuid_ops']::text[],
      ARRAY[NULL::text],
      'triggered_by_request_idisnotnull'::text
    ),
    (
      'public.decision_log'::regclass,
      'idx_decision_log_org_correlation_not_null'::text,
      ARRAY['organization_id', 'correlation_id']::text[],
      ARRAY['uuid_ops', 'uuid_ops']::text[],
      ARRAY[NULL::text, NULL::text],
      'correlation_idisnotnull'::text
    ),
    (
      'public.domain_events'::regclass,
      'idx_domain_events_org_correlation_resource_not_null'::text,
      ARRAY['organization_id', 'correlation_id', 'resource_type', 'resource_id']::text[],
      ARRAY['uuid_ops', 'uuid_ops', 'text_ops', 'uuid_ops']::text[],
      ARRAY[NULL::text, NULL::text, 'default'::text, NULL::text],
      'correlation_idisnotnullandresource_idisnotnull'::text
    )
), topology AS (
  SELECT
    root.*,
    COALESCE(tree.relid, root.relation_name::oid) AS relid,
    tree.parentrelid,
    COALESCE(tree.isleaf, true) AS isleaf,
    COALESCE(tree.level, 0) AS level
  FROM roots root
  LEFT JOIN LATERAL pg_partition_tree(root.relation_name) tree ON true
), candidate_indexes AS (
  SELECT
    topology.*,
    i.indexrelid,
    i.indisready,
    i.indisvalid,
    i.indisunique,
    i.indisprimary,
    i.indnatts,
    i.indnkeyatts,
    ns.nspname AS index_schema,
    ic.relname AS index_name,
    ic.relkind AS index_relkind,
    am.amname AS access_method,
    ARRAY(
      SELECT attribute.attname::text
      FROM generate_series(0, i.indnkeyatts - 1) AS key_position(position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = i.indrelid
       AND attribute.attnum = (i.indkey::int2[])[key_position.position]
      ORDER BY key_position.position
    ) AS key_columns,
    ARRAY(
      SELECT opclass.opcname::text
      FROM generate_series(0, i.indnkeyatts - 1) AS key_position(position)
      JOIN pg_opclass opclass ON opclass.oid = (i.indclass::oid[])[key_position.position]
      ORDER BY key_position.position
    ) AS key_opclasses,
    ARRAY(
      SELECT (i.indoption::int2[])[key_position.position]
      FROM generate_series(0, i.indnkeyatts - 1) AS key_position(position)
      ORDER BY key_position.position
    ) AS key_options,
    ARRAY(
      SELECT coll.collname::text
      FROM generate_series(0, i.indnkeyatts - 1) AS key_position(position)
      LEFT JOIN pg_collation coll
        ON coll.oid = (i.indcollation::oid[])[key_position.position]
      ORDER BY key_position.position
    ) AS key_collations,
    pg_get_expr(i.indpred, i.indrelid) AS predicate,
    pg_get_indexdef(i.indexrelid) AS index_definition,
    parent.oid::oid AS attached_parent_index_oid,
    parent_ns.nspname AS attached_parent_schema,
    parent.relname AS attached_parent_index
  FROM topology
  JOIN pg_index i ON i.indrelid = topology.relid
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_namespace ns ON ns.oid = ic.relnamespace
  JOIN pg_am am ON am.oid = ic.relam
  LEFT JOIN pg_inherits attachment ON attachment.inhrelid = i.indexrelid
  LEFT JOIN pg_class parent ON parent.oid = attachment.inhparent
  LEFT JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
)
SELECT
  relation_name AS root_relation,
  root_index_name,
  i.relid::oid AS table_oid,
  tn.nspname AS table_schema,
  tc.relname AS table_name,
  indexrelid::oid AS index_oid,
  index_schema,
  index_name,
  index_relkind,
  access_method,
  indisready,
  indisvalid,
  indisunique,
  indisprimary,
  indnatts,
  indnkeyatts,
  key_columns,
  key_opclasses,
  key_options,
  key_collations,
  predicate,
  index_definition,
  pg_relation_size(i.indexrelid) AS index_bytes,
  attached_parent_index_oid,
  attached_parent_schema,
  attached_parent_index,
  index_name = root_index_name AS has_canonical_root_name,
  (
    indisready
    AND indisvalid
    AND access_method = 'btree'
    AND NOT indisunique
    AND NOT indisprimary
    AND indnatts = cardinality(expected_columns)
    AND indnkeyatts = cardinality(expected_columns)
    AND key_columns = expected_columns
    AND key_opclasses = expected_opclasses
    AND key_options = array_fill(0::smallint, ARRAY[cardinality(expected_columns)])
    AND key_collations IS NOT DISTINCT FROM expected_collations
    AND regexp_replace(lower(predicate), '["()[:space:]]', '', 'g') = expected_predicate
  ) AS contract_matches
FROM candidate_indexes i
JOIN pg_class tc ON tc.oid = i.relid
JOIN pg_namespace tn ON tn.oid = tc.relnamespace
ORDER BY tc.oid::regclass::text, i.index_name;

-- Any row is a closure defect. This deliberately counts exact contracts rather
-- than filtering the inventory, so missing, malformed, duplicate, detached,
-- and wrongly named roots are all visible for every managed relation.
WITH roots(
  relation_name, root_index_name, expected_columns,
  expected_opclasses, expected_collations, expected_predicate
) AS (
  VALUES
    ('public.workflow_runs'::regclass, 'idx_workflow_runs_triggered_by_request_id_not_null'::text,
      ARRAY['triggered_by_request_id']::text[], ARRAY['uuid_ops']::text[], ARRAY[NULL::text],
      'triggered_by_request_idisnotnull'::text),
    ('public.decision_log'::regclass, 'idx_decision_log_org_correlation_not_null'::text,
      ARRAY['organization_id', 'correlation_id']::text[], ARRAY['uuid_ops', 'uuid_ops']::text[],
      ARRAY[NULL::text, NULL::text], 'correlation_idisnotnull'::text),
    ('public.domain_events'::regclass, 'idx_domain_events_org_correlation_resource_not_null'::text,
      ARRAY['organization_id', 'correlation_id', 'resource_type', 'resource_id']::text[],
      ARRAY['uuid_ops', 'uuid_ops', 'text_ops', 'uuid_ops']::text[],
      ARRAY[NULL::text, NULL::text, 'default'::text, NULL::text],
      'correlation_idisnotnullandresource_idisnotnull'::text)
), topology AS (
  SELECT root.*, COALESCE(tree.relid, root.relation_name::oid) AS relid,
         tree.parentrelid, COALESCE(tree.level, 0) AS level
  FROM roots root
  LEFT JOIN LATERAL pg_partition_tree(root.relation_name) tree ON true
), candidates AS (
  SELECT topology.*, i.indexrelid, ic.relname AS index_name,
    (
      i.indisready AND i.indisvalid
      AND am.amname = 'btree' AND NOT i.indisunique AND NOT i.indisprimary
      AND i.indnatts = cardinality(expected_columns)
      AND i.indnkeyatts = cardinality(expected_columns)
      AND ARRAY(
        SELECT a.attname::text FROM generate_series(0, i.indnkeyatts - 1) p(position)
        JOIN pg_attribute a ON a.attrelid = i.indrelid
          AND a.attnum = (i.indkey::int2[])[p.position]
        ORDER BY p.position
      ) = expected_columns
      AND ARRAY(
        SELECT opc.opcname::text FROM generate_series(0, i.indnkeyatts - 1) p(position)
        JOIN pg_opclass opc ON opc.oid = (i.indclass::oid[])[p.position]
        ORDER BY p.position
      ) = expected_opclasses
      AND ARRAY(
        SELECT (i.indoption::int2[])[p.position]
        FROM generate_series(0, i.indnkeyatts - 1) p(position) ORDER BY p.position
      ) = array_fill(0::smallint, ARRAY[cardinality(expected_columns)])
      AND ARRAY(
        SELECT coll.collname::text FROM generate_series(0, i.indnkeyatts - 1) p(position)
        LEFT JOIN pg_collation coll ON coll.oid = (i.indcollation::oid[])[p.position]
        ORDER BY p.position
      ) IS NOT DISTINCT FROM expected_collations
      AND regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid)), '["()[:space:]]', '', 'g') = expected_predicate
    ) AS contract_matches
  FROM topology
  JOIN pg_index i ON i.indrelid = topology.relid
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_am am ON am.oid = ic.relam
), exact_counts AS (
  SELECT topology.relation_name, topology.root_index_name, topology.relid,
         topology.parentrelid, topology.level,
         count(c.indexrelid) FILTER (WHERE c.contract_matches) AS exact_count,
         (min(c.indexrelid::bigint) FILTER (WHERE c.contract_matches))::oid AS exact_index_oid,
         bool_or(c.contract_matches AND c.index_name = topology.root_index_name) AS canonical_root_match
  FROM topology
  LEFT JOIN candidates c ON c.relid = topology.relid
  GROUP BY topology.relation_name, topology.root_index_name, topology.relid,
           topology.parentrelid, topology.level
)
SELECT
  CASE WHEN exact_count = 0 THEN 'exact_index_contract_missing_or_malformed'
       ELSE 'duplicate_exact_index_contract' END AS defect,
  relation_name AS root_relation,
  relid::regclass AS affected_relation
FROM exact_counts
WHERE exact_count <> 1

UNION ALL

SELECT 'canonical_root_index_missing_or_malformed', relation_name, relid::regclass
FROM exact_counts
WHERE level = 0 AND exact_count = 1 AND NOT COALESCE(canonical_root_match, false)

UNION ALL

SELECT 'attached_child_index_missing', child.relation_name, child.relid::regclass
FROM exact_counts child
JOIN exact_counts parent ON parent.relid = child.parentrelid
WHERE child.level > 0
  AND child.exact_count = 1
  AND parent.exact_count = 1
  AND NOT EXISTS (
    SELECT 1 FROM pg_inherits attachment
    WHERE attachment.inhrelid = child.exact_index_oid
      AND attachment.inhparent = parent.exact_index_oid
  )
ORDER BY 2, 3;

SELECT
  phase_id,
  candidate_sha,
  status,
  attempt_count,
  topology_fingerprint,
  catalog_fingerprint,
  started_at,
  heartbeat_at,
  completed_at,
  details
FROM public.online_index_phase_state_v1
WHERE phase_id = 'shipment_identifier_uuid_guard_v1'
ORDER BY heartbeat_at DESC;

SELECT
  phase_id,
  candidate_sha,
  index_schema,
  build_index_name,
  final_index_name,
  relation_oid::regclass AS relation_name,
  contract_hash,
  ownership_token,
  object_oid,
  status,
  created_at,
  updated_at
FROM public.online_index_artifact_ownership_v1
WHERE phase_id = 'shipment_identifier_uuid_guard_v1'
ORDER BY candidate_sha, index_schema, build_index_name;
