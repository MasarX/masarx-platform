-- UI RPCs use a relation-free, non-bypassing owner so invoker-view and table RLS apply.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261027030000_ui_rpc_executor_role_v1'));

CREATE ROLE ui_rpc_executor NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
  NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Private before-images make the separately authorized rollback independent of source checkout/history.
CREATE TABLE public.ui_rpc_executor_rollback_state_v1 (key TEXT PRIMARY KEY, value JSONB NOT NULL);
INSERT INTO public.table_contracts(table_schema,table_name,created_at_required,updated_at_required,audit_enabled,notes)
VALUES('public','ui_rpc_executor_rollback_state_v1',FALSE,FALSE,FALSE,
  'Private before-images use an owner-controlled integrity seal; no duplicate audit payload ledger.');
SELECT public.enforce_service_only_rls_v1('public.ui_rpc_executor_rollback_state_v1'::regclass);
REVOKE ALL ON TABLE public.ui_rpc_executor_rollback_state_v1 FROM service_role, ui_rpc_executor;
CREATE POLICY ui_rpc_executor_rollback_admin ON public.ui_rpc_executor_rollback_state_v1
  FOR ALL TO postgres USING (TRUE) WITH CHECK (TRUE);
INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value)
SELECT 'entrypoints', jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
  'owner',pg_get_userbyid(p.proowner),'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid)
FROM pg_proc p WHERE p.oid=ANY(ARRAY[
  'public.ui_get_resource_v1(text,uuid)'::regprocedure,
  'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure,
  'public.ui_update_resource_v1(text,text,jsonb)'::regprocedure,
  'public.ui_delete_resource_v1(text,text)'::regprocedure,
  'public.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure,
  'public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure]::oid[]);
INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value)
SELECT 'registry_schema', COALESCE(jsonb_agg(jsonb_build_object('id',id,'schema',schema)), '[]'::jsonb)
FROM public.schema_registry WHERE category='ui_read_registry';
INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value) VALUES
  ('policies','[]'::jsonb),('trusted_relations','[]'::jsonb);

INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value)
SELECT 'modified_functions',jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,
  'owner',pg_get_userbyid(proowner),'before_definition',pg_get_functiondef(oid)) ORDER BY oid::regprocedure::text)
FROM pg_proc WHERE oid=ANY(ARRAY[
  'public.ui_assert_read_relation_allowed_v1(text,text,text,text)'::regprocedure,
  'public.ui_filter_tree_sql_v1(jsonb,jsonb,boolean)'::regprocedure]::oid[]);
DO $relation_guard$
DECLARE
  v_signature REGPROCEDURE:='public.ui_assert_read_relation_allowed_v1(text,text,text,text)'::regprocedure;
  v_definition TEXT:=pg_get_functiondef(v_signature);
  v_before TEXT:=$old$IF array_position(COALESCE(v_reloptions, ARRAY[]::text[]), 'security_invoker=true') IS NULL THEN$old$;
  v_after TEXT:=$new$IF NOT EXISTS(SELECT 1 FROM pg_options_to_table(v_reloptions) opt
      WHERE lower(opt.option_name)='security_invoker' AND opt.option_value::boolean) THEN$new$;
BEGIN
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'expected exactly one shared UI read guard reloption seam';
  END IF;
  EXECUTE replace(v_definition,v_before,v_after);
END;
$relation_guard$;

-- Dynamic $current_user filters execute under ui_rpc_executor after ownership transfer.
CREATE FUNCTION public.ui_rpc_current_user_id_v1()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $claim$
  SELECT auth.uid();
$claim$;
REVOKE ALL ON FUNCTION public.ui_rpc_current_user_id_v1() FROM PUBLIC, anon, authenticated, service_role;
DO $filter_tree_guard$
DECLARE
  v_signature REGPROCEDURE:='public.ui_filter_tree_sql_v1(jsonb,jsonb,boolean)'::regprocedure;
  v_definition TEXT:=pg_get_functiondef(v_signature);
  v_before TEXT:=$old$v_value_sql := 'auth.uid()';$old$;
  v_after TEXT:=$new$v_value_sql := '(SELECT public.ui_rpc_current_user_id_v1())';$new$;
BEGIN
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'expected exactly one ui_filter_tree_sql_v1 current-user seam';
  END IF;
  EXECUTE replace(v_definition,v_before,v_after);
END;
$filter_tree_guard$;
UPDATE public.ui_rpc_executor_rollback_state_v1 SET value=(
  SELECT jsonb_agg(entry||jsonb_build_object('after_definition',pg_get_functiondef(to_regprocedure(entry->>'signature'))) ORDER BY entry->>'signature')
  FROM jsonb_array_elements(value) entry) WHERE key='modified_functions';

INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value)
SELECT 'read_relations',jsonb_build_array(jsonb_build_object('relation',c.oid::regclass::text,
  'before_definition',pg_get_viewdef(c.oid,TRUE),'options',to_jsonb(c.reloptions)))
FROM pg_class c WHERE c.oid='public.route_stop_reassignment_events_read_v1'::regclass;

-- The scoped invoker view and its base-table policy share one SELECT-only predicate.
CREATE FUNCTION public.route_stop_reassignment_event_read_scope_v1(p_organization_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public,extensions,pg_temp
AS $event_scope$
  SELECT public.current_user_scope_type()='tenant'
    AND p_organization_id=public.current_user_org_id()
    AND p_organization_id=public.current_user_scope_id()
    AND public.user_has_capability_v1('routes.read','tenant',public.current_user_scope_id());
$event_scope$;
REVOKE ALL ON FUNCTION public.route_stop_reassignment_event_read_scope_v1(UUID)
  FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE VIEW public.route_stop_reassignment_events_read_v1 WITH(security_invoker=true) AS
SELECT id,organization_id,route_stop_id,shipment_id,source_route_run_id,target_route_run_id,
  event_type,actor_user_id,notes,payload,created_at
FROM public.route_stop_reassignment_events
WHERE public.route_stop_reassignment_event_read_scope_v1(organization_id);
CREATE POLICY ui_rpc_executor_scoped_read ON public.route_stop_reassignment_events
  FOR SELECT TO ui_rpc_executor
  USING(public.route_stop_reassignment_event_read_scope_v1(organization_id));
INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value)
SELECT 'created_policies',jsonb_agg(jsonb_build_object('relation',polrelid::regclass::text,
  'name',polname,'using',pg_get_expr(polqual,polrelid)))
FROM pg_policy WHERE polrelid='public.route_stop_reassignment_events'::regclass
  AND polname='ui_rpc_executor_scoped_read';
INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value)
SELECT 'created_functions',jsonb_build_array(jsonb_build_object('signature',oid::regprocedure::text,
  'owner',pg_get_userbyid(proowner),'definition',pg_get_functiondef(oid)))
FROM pg_proc WHERE oid='public.route_stop_reassignment_event_read_scope_v1(uuid)'::regprocedure;
UPDATE public.ui_rpc_executor_rollback_state_v1 SET value=(
  SELECT jsonb_agg(entry||jsonb_build_object('after_definition',pg_get_viewdef(to_regclass(entry->>'relation'),TRUE)))
  FROM jsonb_array_elements(value) entry) WHERE key='read_relations';

CREATE OR REPLACE FUNCTION public.ui_rpc_request_is_service_v1()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $service$
  -- This narrow claim reader retains postgres ownership; executor never inherits an application role.
  SELECT COALESCE(auth.jwt()->>'role', current_setting('request.jwt.claim.role', TRUE), '') = 'service_role';
$service$;

-- These metadata helpers retain the migration owner's definer boundary, never the executor's.
CREATE OR REPLACE FUNCTION public.ui_rpc_registry_v1(p_scope_type TEXT, p_scope_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $registry$
DECLARE
  v_global JSONB := public.resolve_settings_merged('ui_read_registry', public.get_root_scope_type_key_v1(), NULL);
  v_merged JSONB := public.resolve_settings_merged('ui_read_registry', p_scope_type, p_scope_id);
  v_resources JSONB;
BEGIN
  -- Scoped presentation may narrow a resource, but cannot select a new security boundary.
  SELECT COALESCE(jsonb_agg(
    canonical || (resource - ARRAY['key','relation','read_relation','read_scope_types','id_column','scope_columns','scope','columns',
      'capability_read','capability_write','select','filters','base_filter','allow_delete'])
    ORDER BY ordinal), '[]'::jsonb)
    INTO v_resources
    FROM jsonb_array_elements(COALESCE(v_merged->'resources', '[]'::jsonb)) WITH ORDINALITY AS merged(resource, ordinal)
    JOIN LATERAL (
      SELECT entry AS canonical
        FROM jsonb_array_elements(COALESCE(v_global->'resources', '[]'::jsonb)) entry
       WHERE entry->>'key' = resource->>'key' LIMIT 1
    ) global_resource ON TRUE;
  RETURN jsonb_set(COALESCE(v_merged, '{}'::jsonb), '{resources}', v_resources);
END;
$registry$;

CREATE OR REPLACE FUNCTION public.ui_rpc_relation_rls_active_v1(p_relation REGCLASS)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $rls$
  WITH RECURSIVE relations(oid) AS (
    SELECT p_relation::oid
    UNION
    SELECT d.refobjid FROM relations r
      JOIN pg_class c ON c.oid = r.oid AND c.relkind = 'v'
      JOIN pg_rewrite w ON w.ev_class = r.oid
      JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid
                       AND d.refclassid = 'pg_class'::regclass
      JOIN pg_class child ON child.oid = d.refobjid AND child.relkind IN ('r','p','v','m','f')
     WHERE d.refobjid <> r.oid
  )
  SELECT COALESCE(bool_and(CASE WHEN c.relkind IN ('r','p') THEN row_security_active(c.oid)
      WHEN c.relkind = 'v' THEN EXISTS(SELECT 1 FROM pg_options_to_table(c.reloptions) opt
        WHERE lower(opt.option_name)='security_invoker' AND opt.option_value::boolean)
      ELSE FALSE END), FALSE)
    AND bool_or(c.relkind IN ('r','p'))
    FROM relations r JOIN pg_class c ON c.oid = r.oid;
$rls$;

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

CREATE OR REPLACE FUNCTION public.ui_rpc_assert_mutation_v1(p_key TEXT, p_resource JSONB, p_operation TEXT)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $mutation$
DECLARE
  v_commands JSONB;
BEGIN
  IF p_resource->'scope' = '"global"'::jsonb AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_read_registry global catalogs require platform mutation' USING ERRCODE = '42501';
  END IF;
  IF p_operation = 'delete' THEN
    v_commands := public.resolve_settings_merged('ui_command_registry', public.get_root_scope_type_key_v1(), NULL);
    IF (p_resource->'allow_delete') IS DISTINCT FROM 'true'::jsonb AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_commands->'commands','[]'::jsonb)) command
      WHERE command->>'schema_category' = 'resource:' || p_key
        AND command#>>'{execution,params,handler}' = 'resource_delete') THEN
      RAISE EXCEPTION 'ui_read_registry resource % has no configured delete command', p_key USING ERRCODE = '42501';
    END IF;
  END IF;
END;
$mutation$;

REVOKE ALL ON FUNCTION public.ui_rpc_registry_v1(TEXT, UUID),
  public.ui_rpc_request_is_service_v1(),
  public.ui_rpc_relation_rls_active_v1(REGCLASS),
  public.ui_resource_scope_predicate_v1(JSONB, REGCLASS, TEXT, UUID, TEXT),
  public.ui_rpc_assert_mutation_v1(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- Data-only catalog classification and the three existing direct-delete UI contracts.
UPDATE public.schema_registry
   SET schema = jsonb_set(jsonb_set(schema, '{properties,resources,items,properties,scope}',
     '{"type":"string","enum":["global"]}'::jsonb), '{properties,resources,items,properties,allow_delete}',
     '{"type":"boolean","description":"Global registry authority for generic resource deletion."}'::jsonb)
 WHERE category='ui_read_registry' AND jsonb_typeof(schema#>'{properties,resources,items,properties}')='object';

DO $catalog_config$
DECLARE
  rec RECORD;
  v_next JSONB;
  v_catalogs CONSTANT JSONB := '{"field_mappings":"public.field_mappings",
    "lookup_definitions":"public.lookup_definitions","lookup_values":"public.lookup_values",
    "operation_handlers":"public.operation_handlers","schema_registry":"public.schema_registry",
    "settings_category_registry":"public.settings_category_registry"}'::jsonb;
  v_deletes CONSTANT JSONB := '{"workflow_run_triggers":"public.workflow_run_triggers",
    "workflow_schedule_triggers":"public.workflow_schedule_triggers",
    "workflow_template_steps":"public.workflow_template_steps"}'::jsonb;
BEGIN
  FOR rec IN SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id AND sv.scope_hash=s.scope_hash
    WHERE s.category='ui_read_registry' AND s.scope_type=public.get_root_scope_type_key_v1()
      AND s.scope_id IS NULL ORDER BY s.id FOR UPDATE OF s,sv
  LOOP
    SELECT jsonb_set(rec.value,'{resources}',COALESCE(jsonb_agg(
      resource || CASE WHEN v_catalogs->>(resource->>'key')=resource->>'relation'
        THEN jsonb_build_object('scope','global') ELSE '{}'::jsonb END
        || CASE WHEN v_deletes->>(resource->>'key')=resource->>'relation'
          THEN jsonb_build_object('allow_delete',TRUE) ELSE '{}'::jsonb END
      ORDER BY ordinal),'[]'::jsonb)) INTO v_next
      FROM jsonb_array_elements(rec.value->'resources') WITH ORDINALITY AS resources(resource,ordinal);
    IF v_next IS DISTINCT FROM rec.value THEN
      INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value) VALUES(
        'settings:' || rec.scope_type, jsonb_build_object('scope_type',rec.scope_type,'scope_id',rec.scope_id,
          'before',rec.value,'after',v_next,'schema_version',rec.schema_version));
      PERFORM 1 FROM public.upsert_settings_value_v1('ui_read_registry',rec.scope_type,rec.scope_id,v_next,
        rec.schema_version,'Classify shared read-only catalogs and preserve configured workflow deletes for UI executor');
    END IF;
  END LOOP;
END;
$catalog_config$;
DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';

CREATE OR REPLACE FUNCTION public.ui_get_resource_v1(
  p_resource TEXT,
  p_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.ui_rpc_registry_v1(v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_capability TEXT;
  v_select_cols TEXT;
  v_projection_keys TEXT[];
  v_where TEXT := 'TRUE';
  v_scope_where TEXT;
  v_base_filter_sql TEXT;
  v_sql TEXT;
  v_item JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_get_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 requires id';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 unknown resource %', p_resource;
  END IF;

  PERFORM public.ui_assert_resource_read_scope_v1(v_resource, v_scope_type, v_scope_id);
  v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 relation not found: %', v_relation;
  END IF;

  PERFORM public.ui_assert_read_relation_allowed_v1(
    'ui_get_resource_v1',
    v_relation,
    v_schema,
    v_table
  );

  v_scope_where := public.ui_resource_scope_predicate_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table)), v_scope_type, v_scope_id, NULL
  );
  v_where := v_where || ' AND (' || v_scope_where || ')';

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal)
    INTO v_select_cols
    FROM unnest(v_projection_keys) WITH ORDINALITY AS columns(column_name, ordinal);

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    v_where := v_where || ' AND ' || v_base_filter_sql;
  END IF;

  v_where := v_where || format(' AND %I = %L', v_id_column, p_id);

  v_sql := format(
    'SELECT row_to_json(t)::jsonb FROM (SELECT %s FROM %I.%I WHERE %s LIMIT 1) t',
    v_select_cols,
    v_schema,
    v_table,
    v_where
  );

  EXECUTE v_sql INTO v_item;
  RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_list_resource_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_sort JSONB DEFAULT NULL::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
SET row_security TO 'on'
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.ui_rpc_registry_v1(v_scope_type, v_scope_id);
  v_pagination JSONB := public.resolve_settings_merged('ui_pagination', v_scope_type, v_scope_id);
  v_max_page_size INT := 200;
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_capability TEXT;
  v_select_cols TEXT;
  v_projection_keys TEXT[];
  v_sort_col TEXT;
  v_sort_dir TEXT;
  v_sort_key TEXT;
  v_sort_dir_input TEXT;
  v_group_key TEXT;
  v_group_sort TEXT;
  v_order_sql TEXT;
  v_where TEXT := 'TRUE';
  v_scope_where TEXT;
  v_filter_sql TEXT;
  v_base_filter_sql TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_reloptions TEXT[];
  v_view_security_invoker BOOLEAN := FALSE;
  v_sql TEXT;
  v_items JSONB := '[]'::jsonb;
  v_total BIGINT := 0;
  v_total_strategy TEXT := 'exact';
  v_total_is_estimate BOOLEAN := FALSE;
  v_estimate_filtered_totals BOOLEAN := TRUE;
  v_has_caller_filters BOOLEAN := FALSE;
  v_explain JSONB;
BEGIN
  IF v_pagination IS NOT NULL THEN
    v_max_page_size := COALESCE((v_pagination->>'max_page_size')::int, v_max_page_size);
  END IF;
  v_max_page_size := LEAST(GREATEST(v_max_page_size, 1), 1000);

  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_list_resource_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_list_resource_v1 unknown resource %', p_resource;
  END IF;

  PERFORM public.ui_assert_resource_read_scope_v1(v_resource, v_scope_type, v_scope_id);
  v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';
  v_total_strategy := lower(COALESCE(NULLIF(v_resource->>'total_strategy', ''), v_total_strategy));
  IF v_total_strategy NOT IN ('exact', 'estimate') THEN
    v_total_strategy := 'exact';
  END IF;
  v_estimate_filtered_totals := CASE lower(COALESCE(v_resource->>'estimate_filtered_totals', 'true'))
    WHEN 'false' THEN FALSE
    WHEN '0' THEN FALSE
    WHEN 'no' THEN FALSE
    WHEN 'off' THEN FALSE
    ELSE TRUE
  END;
  v_has_caller_filters := COALESCE(jsonb_typeof(p_filters) = 'object' AND p_filters <> '{}'::jsonb, FALSE);

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_get_resource_v1 resource missing relation';
  END IF;
  v_sort_col := COALESCE(v_resource#>>ARRAY['default_sort', 'column'], v_id_column);
  v_sort_dir := COALESCE(NULLIF(lower(v_resource#>>ARRAY['default_sort', 'direction']), ''), 'desc');

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_list_resource_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity, c.reloptions
    INTO v_relkind, v_rls_enabled, v_reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IN ('r', 'p') THEN
    IF v_rls_enabled IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'ui_list_resource_v1 relation missing RLS: %', v_relation;
    END IF;
  ELSIF v_relkind = 'v' THEN
    v_view_security_invoker := EXISTS(SELECT 1 FROM pg_options_to_table(v_reloptions) opt
      WHERE lower(opt.option_name)='security_invoker' AND opt.option_value::boolean);
    IF v_view_security_invoker IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'ui_list_resource_v1 view missing security_invoker: %', v_relation;
    END IF;
  ELSE
    RAISE EXCEPTION 'ui_list_resource_v1 relation not allowed: %', v_relation;
  END IF;

  v_scope_where := public.ui_resource_scope_predicate_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table)), v_scope_type, v_scope_id, NULL
  );
  v_where := v_where || ' AND (' || v_scope_where || ')';

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal)
    INTO v_select_cols
    FROM unnest(v_projection_keys) WITH ORDINALITY AS columns(column_name, ordinal);

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    IF v_base_filter_sql IS NOT NULL AND btrim(v_base_filter_sql) <> '' THEN
      v_where := v_where || ' AND ' || v_base_filter_sql;
    END IF;
  END IF;

  IF jsonb_typeof(p_sort) = 'object' THEN
    v_sort_key := NULLIF(p_sort->>'key', '');
    v_sort_dir_input := lower(NULLIF(p_sort->>'direction', ''));
    IF v_sort_key IS NOT NULL AND v_sort_key = ANY(v_projection_keys) THEN
      v_sort_col := v_sort_key;
      IF v_sort_dir_input IN ('asc', 'desc') THEN
        v_sort_dir := v_sort_dir_input;
      END IF;
    END IF;
  END IF;

  v_order_sql := format('%I %s', v_sort_col, CASE WHEN v_sort_dir = 'asc' THEN 'ASC' ELSE 'DESC' END);
  v_group_key := NULLIF(p_sort->>'group_key', '');
  IF v_group_key IS NOT NULL THEN
    IF NOT COALESCE(v_group_key = ANY(v_projection_keys), FALSE)
       OR NOT COALESCE((v_resource#>'{task_controls,group_columns}') ? v_group_key, FALSE) THEN
      RAISE EXCEPTION 'ui_list_resource_v1 unconfigured group column %', v_group_key;
    END IF;
    v_group_sort := COALESCE(NULLIF(v_resource#>>ARRAY['task_controls','group_sort_columns',v_group_key], ''), v_group_key);
    IF NOT COALESCE(v_group_sort = ANY(v_projection_keys), FALSE) THEN
      RAISE EXCEPTION 'ui_list_resource_v1 invalid configured group sort column %', v_group_sort;
    END IF;
    v_order_sql := format('%I ASC, ', v_group_sort) || v_order_sql;
  END IF;

  v_filter_sql := public.ui_read_caller_filter_sql_v1(
    p_filters,
    COALESCE(v_resource->'filters', '[]'::jsonb),
    v_projection_keys
  );
  IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
    v_where := v_where || ' AND ' || v_filter_sql;
  END IF;

  IF v_total_strategy = 'estimate'
     AND v_has_caller_filters
     AND v_estimate_filtered_totals IS DISTINCT FROM TRUE THEN
    v_total_strategy := 'exact';
  END IF;

  IF v_total_strategy = 'estimate' THEN
    v_sql := format(
      'EXPLAIN (FORMAT JSON) SELECT 1 FROM %I.%I WHERE %s',
      v_schema,
      v_table,
      v_where
    );
    EXECUTE v_sql INTO v_explain;
    v_total := COALESCE(NULLIF((v_explain->0->'Plan'->>'Plan Rows'), '')::bigint, 0);
    v_total_is_estimate := TRUE;
  ELSE
    v_sql := format(
      'SELECT COUNT(*) FROM %I.%I WHERE %s',
      v_schema,
      v_table,
      v_where
    );
    EXECUTE v_sql INTO v_total;
  END IF;

  v_sql := format(
    'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (SELECT %s FROM %I.%I WHERE %s ORDER BY %s LIMIT %s OFFSET %s) t',
    v_select_cols,
    v_schema,
    v_table,
    v_where,
    v_order_sql,
    LEAST(GREATEST(p_limit, 1), v_max_page_size),
    GREATEST(p_offset, 0)
  );

  EXECUTE v_sql INTO v_items;

  RETURN jsonb_build_object(
    'resource', p_resource,
    'keys', to_jsonb(v_projection_keys),
    'items', COALESCE(v_items, '[]'::jsonb),
    'limit', LEAST(GREATEST(p_limit, 1), v_max_page_size),
    'offset', GREATEST(p_offset, 0),
    'total', COALESCE(v_total, 0),
    'total_strategy', v_total_strategy,
    'total_is_estimate', v_total_is_estimate
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_update_resource_v1(
  p_resource TEXT,
  p_id TEXT,
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.ui_rpc_registry_v1(v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_id_type TEXT;
  v_capability TEXT;
  v_columns JSONB;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_edit_mode TEXT;
  v_edit_permission TEXT;
  v_col_def JSONB;
  v_patch_cols TEXT[] := ARRAY[]::TEXT[];
  v_col TEXT;
  v_col_type TEXT;
  v_set_parts TEXT[] := ARRAY[]::TEXT[];
  v_cols_def TEXT[] := ARRAY[]::TEXT[];
  v_cols_list TEXT[] := ARRAY[]::TEXT[];
  v_select_cols TEXT;
  v_projection_keys TEXT[];
  v_base_filter_sql TEXT;
  v_where TEXT := 'TRUE';
  v_sql TEXT;
  v_result JSONB;
  v_scope_where TEXT;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires id';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires patch object';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  PERFORM public.ui_rpc_assert_mutation_v1(p_resource, v_resource, 'update');
  v_scope_where := public.ui_resource_scope_predicate_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table)), v_scope_type, v_scope_id, 't'
  );

  v_columns := v_resource->'columns';
  IF jsonb_typeof(v_columns) <> 'array' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 resource missing column metadata';
  END IF;

  FOR v_col IN SELECT key FROM jsonb_each(p_patch) LOOP
    IF v_col = v_id_column THEN
      RAISE EXCEPTION 'ui_update_resource_v1 cannot update id column';
    END IF;

    SELECT value INTO v_col_def
      FROM jsonb_array_elements(v_columns) AS value
     WHERE value->>'key' = v_col
     LIMIT 1;

    IF v_col_def IS NULL THEN
      RAISE EXCEPTION 'ui_update_resource_v1 unknown column %', v_col;
    END IF;

    v_edit_mode := lower(COALESCE(NULLIF(v_col_def->>'edit_mode', ''), 'none'));
    IF v_edit_mode NOT IN ('inline','modal','form') THEN
      RAISE EXCEPTION 'ui_update_resource_v1 column not editable: %', v_col;
    END IF;

    v_edit_permission := NULLIF(v_col_def->>'edit_permission', '');
    IF v_edit_permission IS NOT NULL THEN
      PERFORM public.assert_capability_v1(v_edit_permission, v_scope_type, v_scope_id);
    END IF;

    v_patch_cols := array_append(v_patch_cols, v_col);
  END LOOP;

  IF array_length(v_patch_cols, 1) IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires editable patch columns';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_id_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table
     AND a.attname = v_id_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;

  IF v_id_type IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 id column not found: %', v_id_column;
  END IF;

  FOR v_col IN SELECT unnest(v_patch_cols) LOOP
    SELECT format_type(a.atttypid, a.atttypmod)
      INTO v_col_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = v_schema
       AND c.relname = v_table
       AND a.attname = v_col
       AND a.attnum > 0
       AND a.attisdropped = false
     LIMIT 1;

    IF v_col_type IS NULL THEN
      RAISE EXCEPTION 'ui_update_resource_v1 column not found: %', v_col;
    END IF;

    v_cols_def := array_append(v_cols_def, format('%I %s', v_col, v_col_type));
    v_cols_list := array_append(v_cols_list, format('%I', v_col));
    v_set_parts := array_append(v_set_parts, format('%I = patch.%I', v_col, v_col));
  END LOOP;

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );
  SELECT string_agg(format('t.%I', column_name), ', ' ORDER BY ordinal)
    INTO v_select_cols
    FROM unnest(v_projection_keys) WITH ORDINALITY AS columns(column_name, ordinal);

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    v_where := v_where || ' AND ' || v_base_filter_sql;
  END IF;

  -- Resolve predicates against target columns even when patch keys overlap.
  v_sql := format(
    'WITH patch AS (SELECT %s FROM jsonb_to_record($1) AS x(%s)) UPDATE %I.%I AS t SET %s FROM patch WHERE t.%I = $2::%s AND (%s) AND (SELECT %s FROM (SELECT t.*) AS base_row) RETURNING (SELECT to_jsonb(projected) FROM (SELECT %s) projected)',
    array_to_string(v_cols_list, ', '),
    array_to_string(v_cols_def, ', '),
    v_schema,
    v_table,
    array_to_string(v_set_parts, ', '),
    v_id_column,
    v_id_type,
    v_scope_where,
    v_where,
    v_select_cols
  );

  EXECUTE v_sql INTO v_result USING p_patch, p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_delete_resource_v1(
  p_resource TEXT,
  p_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.ui_rpc_registry_v1(v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_id_type TEXT;
  v_capability TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_select_cols TEXT;
  v_projection_keys TEXT[];
  v_base_filter_sql TEXT;
  v_where TEXT := 'TRUE';
  v_sql TEXT;
  v_result JSONB;
  v_scope_where TEXT;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 requires id';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  PERFORM public.ui_rpc_assert_mutation_v1(p_resource, v_resource, 'delete');
  v_scope_where := public.ui_resource_scope_predicate_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table)), v_scope_type, v_scope_id, 't'
  );

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_id_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table
     AND a.attname = v_id_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;

  IF v_id_type IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 id column not found: %', v_id_column;
  END IF;

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );
  SELECT string_agg(format('t.%I', column_name), ', ' ORDER BY ordinal)
    INTO v_select_cols
    FROM unnest(v_projection_keys) WITH ORDINALITY AS columns(column_name, ordinal);

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    v_where := v_where || ' AND ' || v_base_filter_sql;
  END IF;

  v_sql := format(
    'DELETE FROM %I.%I AS t WHERE t.%I = $1::%s AND (%s) AND (%s) RETURNING (SELECT to_jsonb(projected) FROM (SELECT %s) projected)',
    v_schema,
    v_table,
    v_id_column,
    v_id_type,
    v_scope_where,
    v_where,
    v_select_cols
  );

  EXECUTE v_sql INTO v_result USING p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_filter_distinct_values_v1(
  p_resource TEXT,
  p_filter_key TEXT,
  p_query TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.ui_rpc_registry_v1(v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_capability TEXT;
  v_filter JSONB;
  v_column TEXT;
  v_where TEXT := 'TRUE';
  v_scope_where TEXT;
  v_base_filter_sql TEXT;
  v_query TEXT := NULLIF(btrim(p_query), '');
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
  v_sql TEXT;
  v_values JSONB := '[]'::jsonb;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 requires resource key';
  END IF;
  IF p_filter_key IS NULL OR btrim(p_filter_key) = '' THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 requires filter key';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 unknown resource %', p_resource;
  END IF;

  PERFORM public.ui_assert_resource_read_scope_v1(v_resource, v_scope_type, v_scope_id);
  v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');
  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 resource missing relation';
  END IF;

  v_capability := v_resource->>'capability_read';
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 relation not found: %', v_relation;
  END IF;

  PERFORM public.ui_assert_read_relation_allowed_v1(
    'ui_filter_distinct_values_v1',
    v_relation,
    v_schema,
    v_table
  );

  v_scope_where := public.ui_resource_scope_predicate_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table)), v_scope_type, v_scope_id, NULL
  );
  v_where := v_where || ' AND (' || v_scope_where || ')';

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    IF v_base_filter_sql IS NOT NULL AND btrim(v_base_filter_sql) <> '' THEN
      v_where := v_where || ' AND ' || v_base_filter_sql;
    END IF;
  END IF;

  SELECT value INTO v_filter
    FROM jsonb_array_elements(COALESCE(v_resource->'filters', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_filter_key
   LIMIT 1;

  IF v_filter IS NULL THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 unknown filter %', p_filter_key;
  END IF;

  v_column := NULLIF(v_filter->>'column', '');
  IF v_column IS NULL THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 filter missing column: %', p_filter_key;
  END IF;

  IF NOT COALESCE(v_column = ANY(public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  )), FALSE) THEN
    RAISE EXCEPTION 'ui_filter_distinct_values_v1 filter column not allowed: %', p_filter_key;
  END IF;

  IF v_query IS NOT NULL THEN
    v_where := v_where || format(' AND %I::text ILIKE %L', v_column, '%' || v_query || '%');
  END IF;

  v_sql := format(
    'SELECT COALESCE(jsonb_agg(value), ''[]''::jsonb) FROM (' ||
    'SELECT %1$I::text AS value FROM %2$I.%3$I ' ||
    'WHERE %4$s AND %1$I IS NOT NULL AND NULLIF(btrim(%1$I::text), '''') IS NOT NULL ' ||
    'GROUP BY 1 ' ||
    'ORDER BY count(*) DESC, value ASC ' ||
    'LIMIT %5$s' ||
    ') t',
    v_column,
    v_schema,
    v_table,
    v_where,
    v_limit
  );

  EXECUTE v_sql INTO v_values;
  RETURN v_values;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_resource_metrics_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_columns TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.ui_rpc_registry_v1(v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_capability TEXT;
  v_select_keys TEXT[];
  v_projection_keys TEXT[];
  v_numeric_cols TEXT[];
  v_metrics_sql TEXT;
  v_metrics JSONB := '{}'::jsonb;
  v_total BIGINT := 0;
  v_where TEXT := 'TRUE';
  v_scope_where TEXT;
  v_base_filter_sql TEXT;
  v_filter_key TEXT;
  v_filter_sql TEXT;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 requires resource key';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 unknown resource %', p_resource;
  END IF;

  PERFORM public.ui_assert_resource_read_scope_v1(v_resource, v_scope_type, v_scope_id);
  v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_resource_metrics_v1 relation not found: %', v_relation;
  END IF;

  PERFORM public.ui_assert_read_relation_allowed_v1(
    'ui_resource_metrics_v1',
    v_relation,
    v_schema,
    v_table
  );

  v_scope_where := public.ui_resource_scope_predicate_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table)), v_scope_type, v_scope_id, NULL
  );
  v_where := v_where || ' AND (' || v_scope_where || ')';

  v_projection_keys := public.ui_read_projection_columns_v1(
    v_resource, to_regclass(format('%I.%I', v_schema, v_table))
  );

  IF jsonb_typeof(v_resource->'select') = 'array' THEN
    SELECT array_agg(value::text)
      INTO v_select_keys
      FROM jsonb_array_elements_text(v_resource->'select');
  END IF;
  IF v_select_keys IS NULL OR array_length(v_select_keys, 1) IS NULL THEN
    v_select_keys := ARRAY[v_id_column];
  END IF;

  IF p_columns IS NOT NULL AND array_length(p_columns, 1) IS NOT NULL THEN
    v_select_keys := ARRAY(
      SELECT key
        FROM unnest(v_select_keys) AS key
       WHERE key = ANY(p_columns)
    );
  END IF;

  SELECT array_agg(column_name::text)
    INTO v_numeric_cols
    FROM information_schema.columns
   WHERE table_schema = v_schema
     AND table_name = v_table
     AND column_name = ANY(v_select_keys)
     AND data_type IN (
       'smallint',
       'integer',
       'bigint',
       'numeric',
       'decimal',
       'real',
       'double precision'
     );

  IF jsonb_typeof(v_resource->'base_filter') = 'object' THEN
    v_base_filter_sql := public.ui_filter_tree_sql_v1(
      v_resource->'base_filter',
      COALESCE(v_resource->'filters', '[]'::jsonb)
    );
    IF v_base_filter_sql IS NOT NULL AND btrim(v_base_filter_sql) <> '' THEN
      v_where := v_where || ' AND ' || v_base_filter_sql;
    END IF;
  END IF;

  v_filter_sql := public.ui_read_caller_filter_sql_v1(
    p_filters,
    COALESCE(v_resource->'filters', '[]'::jsonb),
    v_projection_keys
  );
  IF v_filter_sql IS NOT NULL AND btrim(v_filter_sql) <> '' THEN
    v_where := v_where || ' AND ' || v_filter_sql;
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM %I.%I WHERE %s', v_schema, v_table, v_where)
    INTO v_total;

  IF v_numeric_cols IS NOT NULL AND array_length(v_numeric_cols, 1) IS NOT NULL THEN
    v_metrics_sql := 'SELECT jsonb_build_object(';
    FOR v_filter_key IN SELECT unnest(v_numeric_cols) LOOP
      v_metrics_sql := v_metrics_sql || format(
        '%L, jsonb_build_object(''count'', COUNT(%I), ''sum'', SUM(%I), ''avg'', AVG(%I), ''min'', MIN(%I), ''max'', MAX(%I)),',
        v_filter_key,
        v_filter_key,
        v_filter_key,
        v_filter_key,
        v_filter_key,
        v_filter_key
      );
    END LOOP;
    v_metrics_sql := trim(trailing ',' from v_metrics_sql) || format(') FROM %I.%I WHERE %s', v_schema, v_table, v_where);
    EXECUTE v_metrics_sql INTO v_metrics;
  END IF;

  RETURN jsonb_build_object(
    'resource', p_resource,
    'total', COALESCE(v_total, 0),
    'columns', COALESCE(v_metrics, '{}'::jsonb)
  );
END;
$$;

-- One catalog-backed plan is used for both deterministic provisioning and exact ACL tests.
CREATE OR REPLACE FUNCTION public.ui_rpc_executor_privilege_plan_v1()
RETURNS TABLE(object_kind TEXT, object_id OID, privilege TEXT, column_name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $plan$
  WITH RECURSIVE resources AS (
    SELECT resource, to_regclass(resource->>'relation') AS relation,
      to_regclass(COALESCE(NULLIF(btrim(resource->>'read_relation'), ''), resource->>'relation')) AS read_relation
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged(
        'ui_read_registry', public.get_root_scope_type_key_v1(), NULL)->'resources','[]'::jsonb)) resource
  ), mutations AS (
    SELECT r.relation::oid AS oid, 'UPDATE'::text AS operation, col->>'key' AS column_name FROM resources r
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.resource->'columns','[]'::jsonb)) col
      JOIN pg_class c ON c.oid=r.relation AND c.relkind IN ('r','p')
      JOIN pg_attribute a ON a.attrelid=r.relation AND a.attname=col->>'key' AND a.attnum>0 AND NOT a.attisdropped
     WHERE lower(col->>'edit_mode') IN ('inline','modal','form') AND col->>'key'<>COALESCE(r.resource->>'id_column','id')
    UNION
    SELECT r.relation::oid, 'DELETE', NULL FROM resources r
      JOIN pg_class c ON c.oid=r.relation AND c.relkind IN ('r','p')
     WHERE r.resource->'allow_delete'='true'::jsonb OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged(
       'ui_command_registry',public.get_root_scope_type_key_v1(),NULL)->'commands','[]'::jsonb)) command
       WHERE command->>'schema_category'='resource:' || (r.resource->>'key')
         AND command#>>'{execution,params,handler}'='resource_delete')
  ), invoker_rewrites AS (
    SELECT w.oid,w.ev_class FROM pg_rewrite w JOIN pg_class c ON c.oid=w.ev_class
     WHERE c.relkind='v' AND EXISTS(SELECT 1 FROM pg_options_to_table(c.reloptions) opt
       WHERE lower(opt.option_name)='security_invoker' AND opt.option_value::boolean)
  ), relation_edges(parent, child) AS (
    SELECT w.ev_class, d.refobjid FROM invoker_rewrites w JOIN pg_depend d
      ON d.classid='pg_rewrite'::regclass AND d.objid=w.oid AND d.refclassid='pg_class'::regclass
    UNION
    SELECT p.polrelid, d.refobjid FROM pg_policy p JOIN pg_depend d
      ON d.classid='pg_policy'::regclass AND d.objid=p.oid AND d.refclassid='pg_class'::regclass
     WHERE (0=ANY(p.polroles)
       OR 'authenticated'::regrole::oid=ANY(p.polroles) OR 'ui_rpc_executor'::regrole::oid=ANY(p.polroles))
  ), entrypoints(oid) AS (
    SELECT unnest(ARRAY[
      'public.ui_get_resource_v1(text,uuid)'::regprocedure::oid,
      'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure::oid,
      'public.ui_update_resource_v1(text,text,jsonb)'::regprocedure::oid,
      'public.ui_delete_resource_v1(text,text)'::regprocedure::oid,
      'public.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure::oid,
      'public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure::oid])
  ), function_edges(parent, child, needs_schema_usage) AS (
    -- PL/pgSQL does not record call dependencies; named calls complement catalog dependencies.
    SELECT p.oid, child.oid, TRUE FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
      CROSS JOIN LATERAL regexp_matches(p.prosrc, '([a-zA-Z_][a-zA-Z_0-9]*)\.([a-zA-Z_][a-zA-Z_0-9]*)\s*\(', 'g') call
      JOIN pg_namespace child_n ON child_n.oid=CASE WHEN call[1]='pg_temp' THEN pg_my_temp_schema() ELSE to_regnamespace(call[1]) END
      JOIN pg_proc child ON child.pronamespace=child_n.oid AND child.proname=call[2] AND child.prokind='f'
     WHERE NOT p.prosecdef OR p.oid IN (SELECT oid FROM entrypoints)
    UNION
    SELECT p.oid, d.refobjid, FALSE FROM pg_proc p JOIN pg_depend d
      ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_proc'::regclass
     WHERE NOT p.prosecdef OR p.oid IN (SELECT oid FROM entrypoints)
  ), function_relation_edges(parent, child) AS (
    SELECT p.oid, d.refobjid FROM pg_proc p JOIN pg_depend d
      ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_class'::regclass
     WHERE NOT p.prosecdef OR p.oid IN (SELECT oid FROM entrypoints)
    UNION
    -- String-defined invoker SQL helpers also need their data reads, without widening definer boundaries.
    SELECT p.oid, c.oid FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
      CROSS JOIN LATERAL regexp_matches(p.prosrc,
        '(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z_0-9]*)\.([a-zA-Z_][a-zA-Z_0-9]*)\M', 'gi') reference
      JOIN pg_namespace child_n ON child_n.oid=CASE WHEN reference[1]='pg_temp' THEN pg_my_temp_schema() ELSE to_regnamespace(reference[1]) END
      JOIN pg_class c ON c.relnamespace=child_n.oid AND c.relname=reference[2] AND c.relkind IN ('r','p','v')
     WHERE NOT p.prosecdef OR p.oid IN (SELECT oid FROM entrypoints)
  ), function_write_sources AS (
    SELECT p.oid,p.prosrc,COALESCE((SELECT substr(setting,13) FROM unnest(p.proconfig) setting
      WHERE setting LIKE 'search_path=%'),current_setting('search_path')) AS search_path
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
     WHERE NOT p.prosecdef AND p.prokind='f'
  ), function_configured_paths AS (
    SELECT p.oid,n.oid AS namespace,path.position FROM function_write_sources p
      CROSS JOIN LATERAL regexp_matches(p.search_path,'((?:[^",]|"(?:[^"]|"")*")+)', 'g') WITH ORDINALITY path(part,position)
      JOIN pg_namespace n ON n.oid=CASE WHEN btrim(path.part[1]) IN ('pg_temp','"pg_temp"') THEN pg_my_temp_schema()
        ELSE to_regnamespace(CASE WHEN btrim(path.part[1]) IN ('$user','"$user"')
          THEN 'ui_rpc_executor' ELSE btrim(path.part[1]) END) END
  ), function_effective_paths AS (
    SELECT * FROM function_configured_paths
    UNION ALL
    SELECT p.oid,pg_my_temp_schema(),-2 FROM function_write_sources p
     WHERE pg_my_temp_schema()<>0 AND NOT EXISTS(SELECT 1 FROM function_configured_paths path
       WHERE path.oid=p.oid AND path.namespace=pg_my_temp_schema())
    UNION ALL
    SELECT p.oid,'pg_catalog'::regnamespace,-1 FROM function_write_sources p
     WHERE NOT EXISTS(SELECT 1 FROM function_configured_paths path
       WHERE path.oid=p.oid AND path.namespace='pg_catalog'::regnamespace)
  ), function_write_references AS (
    SELECT p.oid,reference[1] AS operation,parse_ident(reference[2]) AS name
      FROM function_write_sources p CROSS JOIN LATERAL regexp_matches(p.prosrc,
        '\m(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?((?:"(?:[^"]|"")*"|[a-zA-Z_][a-zA-Z_0-9]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[a-zA-Z_][a-zA-Z_0-9]*))?)(?=\s|\(|;|$)', 'gi') reference
    UNION
    -- ON CONFLICT DO UPDATE needs UPDATE privileges and its UPDATE triggers too.
    SELECT p.oid,'UPDATE',parse_ident(reference[1])
      FROM function_write_sources p CROSS JOIN LATERAL regexp_matches(p.prosrc,
        '\mINSERT\s+INTO\s+((?:"(?:[^"]|"")*"|[a-zA-Z_][a-zA-Z_0-9]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[a-zA-Z_][a-zA-Z_0-9]*))?)(?=\s|\()[^;]*\mON\s+CONFLICT\M[^;]*\mDO\s+UPDATE\M', 'gi') reference
  ), function_write_edges(parent, child, operation) AS (
    SELECT p.oid,c.oid,CASE WHEN upper(p.operation) LIKE 'INSERT%' THEN 'INSERT'
      WHEN upper(p.operation) LIKE 'DELETE%' THEN 'DELETE' ELSE 'UPDATE' END
      FROM function_write_references p JOIN LATERAL (
        SELECT c.oid,c.relkind FROM (
          SELECT CASE WHEN p.name[1]='pg_temp' THEN pg_my_temp_schema() ELSE to_regnamespace(quote_ident(p.name[1])) END AS namespace,
            0 AS position WHERE cardinality(p.name)=2
          UNION ALL
          SELECT path.namespace,path.position FROM function_effective_paths path WHERE path.oid=p.oid AND cardinality(p.name)=1
        ) path JOIN pg_class c ON c.relnamespace=path.namespace AND c.relname=p.name[cardinality(p.name)]
         ORDER BY path.position LIMIT 1
      ) c ON c.relkind IN ('r','p')
  ), object_edges(parent_kind,parent,child_kind,child) AS (
    SELECT 'relation'::text,parent,'relation'::text,child FROM relation_edges
    UNION SELECT 'function',parent,'function',child FROM function_edges
    UNION SELECT 'function',parent,'relation',child FROM function_relation_edges
    UNION SELECT 'function',parent,operation,child FROM function_write_edges

    UNION
    SELECT operation,t.tgrelid,'function',t.tgfoid FROM pg_trigger t
      CROSS JOIN (VALUES ('INSERT',4),('UPDATE',16),('DELETE',8)) op(operation,mask)
     WHERE NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND (t.tgtype::int & op.mask)<>0
    UNION
    SELECT operation,i.inhparent,operation,i.inhrelid FROM pg_inherits i
      CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) op(operation)
    UNION
    SELECT operation,c.oid,'relation',c.oid FROM pg_class c
      CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) op(operation)
    UNION
    SELECT 'relation',p.polrelid,'function',d.refobjid FROM pg_policy p
      JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=p.oid AND d.refclassid='pg_proc'::regclass
     WHERE (0=ANY(p.polroles)
       OR 'authenticated'::regrole::oid=ANY(p.polroles) OR 'ui_rpc_executor'::regrole::oid=ANY(p.polroles))
    UNION
    -- Function EXECUTE is checked as the querying user for every view.
    SELECT 'relation',w.ev_class,'function',d.refobjid FROM pg_rewrite w
      JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=w.oid AND d.refclassid='pg_proc'::regclass
    UNION
    -- Below definer views, traverse for caller function privileges without granting relations.
    SELECT 'relation',c.oid,'view_dependency',c.oid FROM pg_class c
     WHERE c.relkind='v' AND NOT EXISTS(SELECT 1 FROM pg_options_to_table(c.reloptions) opt
       WHERE lower(opt.option_name)='security_invoker' AND opt.option_value::boolean)
    UNION
    SELECT 'view_dependency',w.ev_class,
      CASE WHEN d.refclassid='pg_proc'::regclass THEN 'function' ELSE 'view_dependency' END,d.refobjid
      FROM pg_rewrite w JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=w.oid
        AND d.refclassid IN ('pg_proc'::regclass,'pg_class'::regclass)
    UNION
    SELECT 'view_dependency',p.polrelid,'function',d.refobjid FROM pg_policy p
      JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=p.oid AND d.refclassid='pg_proc'::regclass
  ), objects(kind,oid) AS (
    SELECT 'relation'::text,relation::oid FROM resources WHERE relation IS NOT NULL
    UNION SELECT 'relation',read_relation::oid FROM resources WHERE read_relation IS NOT NULL
    UNION SELECT operation,oid FROM mutations
    UNION SELECT 'function',oid FROM entrypoints
    UNION SELECT 'function',unnest(ARRAY['public.is_platform_user()'::regprocedure::oid,
      'public.ui_rpc_request_is_service_v1()'::regprocedure::oid,
      'public.ui_rpc_current_user_id_v1()'::regprocedure::oid])
    UNION
    SELECT e.child_kind,e.child FROM objects o JOIN object_edges e
      ON e.parent_kind=o.kind AND e.parent=o.oid
  ), relations(oid) AS (
    SELECT o.oid FROM objects o JOIN pg_class c ON c.oid=o.oid AND c.relkind IN ('r','p','v') WHERE o.kind='relation'
  ), functions(oid) AS (
    SELECT oid FROM objects WHERE kind='function'
  ), privileges AS (
    SELECT 'relation'::text AS object_kind, r.oid AS object_id, 'SELECT'::text AS privilege, NULL::text AS column_name
      FROM relations r JOIN pg_class c ON c.oid=r.oid WHERE NOT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
         WHERE acl.grantee=0 AND acl.privilege_type='SELECT')
    UNION
    SELECT 'relation',oid,operation,column_name FROM mutations
    UNION
    SELECT 'relation',e.child,e.operation,NULL FROM objects o JOIN function_write_edges e ON e.parent=o.oid
     WHERE o.kind='function'
    UNION
    SELECT 'function', f.oid, 'EXECUTE', NULL FROM functions f JOIN pg_proc p ON p.oid=f.oid
     WHERE f.oid NOT IN (SELECT oid FROM entrypoints) AND NOT EXISTS (
       SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
  )
  SELECT * FROM privileges
  UNION
  SELECT 'schema', n.oid, 'USAGE', NULL FROM relations r JOIN pg_class c ON c.oid=r.oid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl
       WHERE acl.grantee=0 AND acl.privilege_type='USAGE')
  UNION
  -- Stored policy/view OIDs need EXECUTE, not schema name resolution. Named invoker calls need both.
  SELECT 'schema', n.oid, 'USAGE', NULL FROM objects o
    JOIN function_edges edge ON edge.parent=o.oid AND edge.needs_schema_usage
    JOIN pg_proc p ON p.oid=edge.child JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE o.kind='function' AND NOT EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl
       WHERE acl.grantee=0 AND acl.privilege_type='USAGE');
$plan$;
REVOKE ALL ON FUNCTION public.ui_rpc_executor_privilege_plan_v1() FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;

DO $grants$
DECLARE
  rec RECORD;
  pol RECORD;
  v_roles TEXT;
  v_signature TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid='public.ui_rpc_request_is_service_v1()'::regprocedure
        AND p.prosecdef AND p.proowner<>'ui_rpc_executor'::regrole) THEN
    RAISE EXCEPTION 'ui_rpc_executor requires a separately owned SECURITY DEFINER claim reader'
      USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(public.resolve_settings_merged('ui_read_registry',public.get_root_scope_type_key_v1(),NULL)->'resources')
      IS DISTINCT FROM 'array' OR jsonb_array_length(public.resolve_settings_merged(
        'ui_read_registry',public.get_root_scope_type_key_v1(),NULL)->'resources')=0 THEN
    RAISE EXCEPTION 'ui_rpc_executor requires a nonempty global registry';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.resolve_settings_merged(
      'ui_read_registry',public.get_root_scope_type_key_v1(),NULL)->'resources') resource
      GROUP BY resource->>'key' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'ui_rpc_executor global registry has duplicate resource keys';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged(
      'ui_read_registry', public.get_root_scope_type_key_v1(), NULL)->'resources','[]'::jsonb)) resource
      WHERE to_regclass(resource->>'relation') IS NULL
        OR to_regclass(COALESCE(NULLIF(btrim(resource->>'read_relation'), ''), resource->>'relation')) IS NULL) THEN
    RAISE EXCEPTION 'ui_rpc_executor registry contains an unresolved relation';
  END IF;
  INSERT INTO public.ui_rpc_executor_rollback_state_v1(key,value)
    SELECT 'grants',jsonb_agg(to_jsonb(p)) FROM public.ui_rpc_executor_privilege_plan_v1() p;
  FOR rec IN SELECT * FROM public.ui_rpc_executor_privilege_plan_v1()
    ORDER BY object_kind, object_id, privilege, column_name NULLS FIRST
  LOOP
    IF rec.object_kind='relation' THEN
      EXECUTE format('GRANT %s%s ON TABLE %s TO ui_rpc_executor', rec.privilege,
        CASE WHEN rec.column_name IS NULL THEN '' ELSE format(' (%I)',rec.column_name) END, rec.object_id::regclass);
    ELSIF rec.object_kind='function' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ui_rpc_executor',rec.object_id::regprocedure);
    ELSIF rec.object_kind='schema' THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO ui_rpc_executor',(SELECT nspname FROM pg_namespace WHERE oid=rec.object_id));
    END IF;
    -- GRANT can warn without failing when the migration role lacks grant authority.
    IF (rec.object_kind='relation' AND CASE WHEN rec.column_name IS NULL
          THEN NOT has_table_privilege('ui_rpc_executor',rec.object_id,rec.privilege)
          ELSE NOT has_column_privilege('ui_rpc_executor',rec.object_id,rec.column_name,rec.privilege) END)
       OR (rec.object_kind='function' AND NOT has_function_privilege('ui_rpc_executor',rec.object_id,rec.privilege))
       OR (rec.object_kind='schema' AND NOT has_schema_privilege('ui_rpc_executor',rec.object_id,rec.privilege)) THEN
      RAISE EXCEPTION 'ui_rpc_executor grant did not take effect: % % % %',
        rec.object_kind,CASE rec.object_kind WHEN 'schema' THEN rec.object_id::regnamespace::text
          WHEN 'function' THEN rec.object_id::regprocedure::text ELSE rec.object_id::regclass::text END,
        rec.privilege,rec.column_name USING ERRCODE='42501',
        HINT='The migration role needs grant authority on the dependency object.';
    END IF;
  END LOOP;

  FOR rec IN SELECT DISTINCT c.oid, c.relkind FROM public.ui_rpc_executor_privilege_plan_v1() p
      JOIN pg_class c ON c.oid=p.object_id WHERE p.object_kind='relation' AND c.relkind IN ('r','p') ORDER BY c.oid
  LOOP
    FOR pol IN SELECT * FROM pg_policy WHERE polrelid=rec.oid
      AND 'authenticated'::regrole::oid=ANY(polroles) AND NOT 0=ANY(polroles) ORDER BY polname
    LOOP
      UPDATE public.ui_rpc_executor_rollback_state_v1 SET value=value || jsonb_build_array(jsonb_build_object(
        'relation',rec.oid::regclass::text,'name',pol.polname,'roles',
        (SELECT jsonb_agg(rolname ORDER BY rolname) FROM pg_roles WHERE oid=ANY(pol.polroles)))) WHERE key='policies';
      SELECT string_agg(quote_ident(rolname),', ' ORDER BY rolname) INTO v_roles
        FROM pg_roles WHERE oid=ANY(pol.polroles) OR rolname='ui_rpc_executor';
      EXECUTE format('ALTER POLICY %I ON %s TO %s',pol.polname,rec.oid::regclass,v_roles);
    END LOOP;
    UPDATE public.ui_rpc_executor_rollback_state_v1 SET value=value || to_jsonb(rec.oid::regclass::text)
      WHERE key='trusted_relations';
    -- Restore trusted service/platform behavior through claim-aware policies, never SQL-role bypass.
    EXECUTE format('CREATE POLICY ui_rpc_executor_trusted ON %s FOR ALL TO ui_rpc_executor USING '
      || '(public.is_platform_user() OR public.ui_rpc_request_is_service_v1()) WITH CHECK '
      || '(public.is_platform_user() OR public.ui_rpc_request_is_service_v1())',rec.oid::regclass);
  END LOOP;
  -- Transfer requires temporary schema CREATE and SET membership; neither survives this transaction.
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT ui_rpc_executor TO %I WITH INHERIT FALSE, SET TRUE',current_user);
  ELSE
    EXECUTE format('GRANT ui_rpc_executor TO %I',current_user);
  END IF;
  GRANT CREATE ON SCHEMA public TO ui_rpc_executor;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.ui_get_resource_v1(text,uuid)', 'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)',
    'public.ui_update_resource_v1(text,text,jsonb)', 'public.ui_delete_resource_v1(text,text)',
    'public.ui_filter_distinct_values_v1(text,text,text,integer)', 'public.ui_resource_metrics_v1(text,jsonb,text[])'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO ui_rpc_executor',v_signature);
  END LOOP;
  REVOKE CREATE ON SCHEMA public FROM ui_rpc_executor;
  EXECUTE format('REVOKE ui_rpc_executor FROM %I',current_user);
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE member='ui_rpc_executor'::regrole
      OR (roleid='ui_rpc_executor'::regrole AND (
        COALESCE((to_jsonb(m)->>'inherit_option')::boolean, TRUE)
        OR COALESCE((to_jsonb(m)->>'set_option')::boolean, TRUE)))) THEN
    RAISE EXCEPTION 'ui_rpc_executor must have no inherited roles or inheriting/SET members after ownership transfer';
  END IF;
END;
$grants$;

-- Table comments require ownership, so data grants cannot replace the integrity anchor.
DO $seal$
DECLARE v_digest TEXT;
BEGIN
  SELECT encode(pg_catalog.sha256(convert_to(COALESCE(jsonb_object_agg(key,value ORDER BY key),'{}'::jsonb)::text,'UTF8')),'hex')
    INTO v_digest FROM public.ui_rpc_executor_rollback_state_v1;
  EXECUTE format('COMMENT ON TABLE public.ui_rpc_executor_rollback_state_v1 IS %L',
    'ui_rpc_executor_rollback_state_v1:sha256:' || v_digest);
END;
$seal$;

COMMENT ON ROLE ui_rpc_executor IS 'NOLOGIN, no relation ownership, inherited roles or inheriting/SET members; six UI RPCs enforce caller JWT RLS plus canonical registry predicates.';
COMMENT ON FUNCTION public.ui_rpc_executor_privilege_plan_v1() IS 'Private deterministic global-registry, invoker-view/policy dependency and call graph ACL plan; rerun provisioning through a reviewed migration after contract changes.';
COMMIT;
