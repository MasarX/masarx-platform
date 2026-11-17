-- Rollback 20261105130000: restore the 20261027030000 scope predicate; registry scope mappings stay (they only narrow reads).
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
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
DROP FUNCTION public.ui_scope_partition_column_v1(TEXT, REGCLASS);
COMMIT;
