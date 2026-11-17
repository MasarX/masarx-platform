-- Folds #3412: client/sender UI reads fail closed on customer-partitioned data without a direct scope column.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261105130000_ui_read_customer_scope_fail_closed_v2'));

-- The column on a relation that partitions it by p_scope_type, derived from the scope registry and ladder edges.
CREATE OR REPLACE FUNCTION public.ui_scope_partition_column_v1(p_scope_type TEXT, p_relation REGCLASS)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $partition$
  SELECT a.attname::text
    FROM (
      SELECT r.id_column AS column_name, 0 AS priority
        FROM public.scope_type_registry r
       WHERE r.scope_type = p_scope_type AND r.is_enabled AND r.entity_table = p_relation
      UNION ALL
      SELECT e.child_parent_column, 1
        FROM public.scope_ladder_edges e
       WHERE e.parent_scope_type = p_scope_type AND e.is_enabled
    ) candidate
    JOIN pg_attribute a ON a.attrelid = p_relation AND a.attname = candidate.column_name
     AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
   ORDER BY candidate.priority, candidate.column_name
   LIMIT 1;
$partition$;
REVOKE ALL ON FUNCTION public.ui_scope_partition_column_v1(TEXT, REGCLASS)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_scope_partition_column_v1(TEXT, REGCLASS) TO ui_rpc_executor;

-- Registry first: map every customer-partitioned resource to its client/sender column before reads fail closed.
DO $registry_scope$
DECLARE
  rec RECORD;
  v_next JSONB;
BEGIN
  FOR rec IN SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry' AND s.scope_type = public.get_root_scope_type_key_v1()
      AND s.scope_id IS NULL ORDER BY s.id FOR UPDATE OF s, sv
  LOOP
    SELECT jsonb_set(rec.value, '{resources}', COALESCE(jsonb_agg(
      CASE WHEN (resource->'scope') IS DISTINCT FROM '"global"'::jsonb AND mapped.columns <> '{}'::jsonb
        THEN jsonb_set(resource, '{scope_columns}', COALESCE(resource->'scope_columns', '{}'::jsonb) || mapped.columns)
        ELSE resource END
      ORDER BY ordinal), '[]'::jsonb)) INTO v_next
      FROM jsonb_array_elements(rec.value->'resources') WITH ORDINALITY AS resources(resource, ordinal)
      CROSS JOIN LATERAL (
        SELECT COALESCE(jsonb_object_agg(scope.scope_type, scope.column_name), '{}'::jsonb) AS columns
          FROM (SELECT customer.scope_type, public.ui_scope_partition_column_v1(customer.scope_type,
                  to_regclass(COALESCE(NULLIF(btrim(resource->>'read_relation'), ''), resource->>'relation'))) AS column_name
                  FROM unnest(ARRAY['client', 'sender']) AS customer(scope_type)
                 WHERE NULLIF(btrim(resource#>>ARRAY['scope_columns', customer.scope_type]), '') IS NULL) scope
         WHERE scope.column_name IS NOT NULL
      ) mapped;
    IF v_next IS DISTINCT FROM rec.value THEN
      PERFORM 1 FROM public.upsert_settings_value_v1('ui_read_registry', rec.scope_type, rec.scope_id, v_next,
        rec.schema_version, 'Map customer-partitioned UI read resources to their client/sender scope columns');
    END IF;
  END LOOP;
END;
$registry_scope$;
DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';

-- Body from 20261027030000; only the customer-scope fail-closed block is new.
CREATE OR REPLACE FUNCTION public.ui_resource_scope_predicate_v1(
  p_resource JSONB, p_relation REGCLASS, p_scope_type TEXT, p_scope_id UUID,
  p_alias TEXT DEFAULT NULL
)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $scope$
DECLARE
  v_path JSONB;
  v_scope RECORD;
  v_column TEXT;
  v_scope_id UUID := p_scope_id;
BEGIN
  IF public.is_platform_user() THEN RETURN 'TRUE'; END IF;
  IF p_scope_type IS NULL AND NOT public.ui_rpc_request_is_service_v1() THEN
    RAISE EXCEPTION 'ui_read_registry requires an active user scope' USING ERRCODE = '42501';
  END IF;
  IF p_scope_type IS NOT NULL THEN
    -- Legacy tenant identities may omit access_scope_id while retaining organization_id.
    IF public.normalize_scope_type_v1(p_scope_type, FALSE) = 'tenant' AND v_scope_id IS NULL THEN
      v_scope_id := public.current_user_org_id();
    END IF;
    v_path := public.resolve_scope_path_v1(public.normalize_scope_type_v1(p_scope_type, FALSE), v_scope_id);
    -- Even an unresolved direct mapping is a constraint, never permission to broaden.
    v_column := NULLIF(btrim(p_resource#>>ARRAY['scope_columns', p_scope_type]), '');
    IF v_column IS NOT NULL AND v_scope_id IS NULL THEN RETURN 'FALSE'; END IF;
    -- Customer-partitioned rows never fall back to an ancestor (tenant-wide) predicate.
    IF v_column IS NULL AND public.normalize_scope_type_v1(p_scope_type, FALSE) IN ('client', 'sender')
       AND (p_resource->'scope') IS DISTINCT FROM '"global"'::jsonb
       AND public.ui_scope_partition_column_v1(public.normalize_scope_type_v1(p_scope_type, FALSE), p_relation) IS NOT NULL THEN
      RAISE EXCEPTION 'ui_read_registry resource % requires a % scope column', p_resource->>'key',
        public.normalize_scope_type_v1(p_scope_type, FALSE) USING ERRCODE = '42501';
    END IF;
    FOR v_scope IN
      SELECT entry->>'scope_type' AS scope_type, (entry->>'scope_id')::uuid AS scope_id
        FROM jsonb_array_elements(v_path) WITH ORDINALITY AS path(entry, ordinal)
       ORDER BY ordinal
    LOOP
      v_column := NULLIF(btrim(p_resource#>>ARRAY['scope_columns', v_scope.scope_type]), '');
      IF v_column IS NOT NULL THEN
        IF v_scope.scope_id IS NULL THEN RETURN 'FALSE'; END IF;
        RETURN format('%s%I = %L', CASE WHEN p_alias IS NULL THEN '' ELSE format('%I.',p_alias) END,
          v_column, v_scope.scope_id);
      END IF;
    END LOOP;
  END IF;
  IF NOT COALESCE(public.ui_rpc_relation_rls_active_v1(p_relation), FALSE)
     AND (p_resource->'scope') IS DISTINCT FROM '"global"'::jsonb
     AND NOT public.ui_rpc_request_is_service_v1() THEN
    RAISE EXCEPTION 'ui_read_registry resource % requires scope mapping or executor RLS', p_resource->>'key'
      USING ERRCODE = '42501';
  END IF;
  RETURN 'TRUE';
END;
$scope$;
REVOKE ALL ON FUNCTION public.ui_resource_scope_predicate_v1(JSONB, REGCLASS, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $verify$
BEGIN
  IF NOT has_function_privilege('ui_rpc_executor', 'public.ui_resource_scope_predicate_v1(jsonb,regclass,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('ui_rpc_executor', 'public.ui_scope_partition_column_v1(text,regclass)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ui_rpc_executor lost EXECUTE on the shared UI read scope predicate';
  END IF;
END;
$verify$;

COMMIT;
