BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

CREATE TEMP TABLE read_scope_rows(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL);
ALTER TABLE pg_temp.read_scope_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_scope_rows_select ON pg_temp.read_scope_rows FOR SELECT TO ui_rpc_executor
  USING (organization_id = public.current_user_org_id());
GRANT SELECT ON pg_temp.read_scope_rows TO ui_rpc_executor;
DO $schema$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ui_rpc_executor', pg_my_temp_schema()::regnamespace);
END;
$schema$;

CREATE FUNCTION pg_temp.test_ui_read_scope_guard_v1()
RETURNS SETOF text LANGUAGE plpgsql AS $test$
DECLARE
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_sender uuid := gen_random_uuid();
  v_row uuid := gen_random_uuid();
  v_root text := public.get_root_scope_type_key_v1();
  v_registry jsonb;
  v_resource jsonb;
  v_policy jsonb;
  v_schema integer;
  v_role text := 'qa_read_scope_guard';
  v_scope text;
  v_scope_id uuid;
BEGIN
  SELECT sv.value, sv.schema_version INTO STRICT v_registry, v_schema
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
  WHERE s.category = 'ui_read_registry' AND s.scope_type = v_root AND s.scope_id IS NULL;

  SELECT item INTO STRICT v_resource
  FROM jsonb_array_elements(public.ui_rpc_registry_v1(v_root, NULL)->'resources') AS item
  WHERE item->>'key' = 'route_stop_reassignment_events';
  RETURN NEXT is(v_resource->'read_scope_types', '["tenant"]'::jsonb, 'registry read-scope policy');
  RETURN NEXT is(v_resource#>>'{scope_columns,tenant}', 'organization_id', 'registry read-scope binding');

  v_resource := jsonb_build_object(
    'key', 'qa_read_scope_guard', 'relation', format('%I.read_scope_rows', pg_my_temp_schema()::regnamespace),
    'id_column', 'id', 'capability_read', 'webhooks.read', 'select', jsonb_build_array('id', 'name'),
    'read_scope_types', jsonb_build_array('tenant'), 'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'filters', jsonb_build_array(jsonb_build_object('key', 'name', 'column', 'name', 'op', 'eq')),
    'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc')
  );
  v_registry := jsonb_set(v_registry, '{resources}', v_registry->'resources' || jsonb_build_array(v_resource));
  PERFORM public.upsert_settings_value_v1('ui_read_registry', v_root, NULL, v_registry, v_schema, 'Read-scope guard fixture');
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';

  INSERT INTO public.organizations(id, name, slug) VALUES (v_org, 'Read scope fixture', 'read-scope-' || v_org);
  INSERT INTO public.clients(id, organization_id, name, slug, status)
    VALUES (v_client, v_org, 'Read scope fixture', 'read-scope-' || v_client, 'active');
  INSERT INTO public.senders(id, client_id, name, status) VALUES (v_sender, v_client, 'Read scope fixture', 'active');
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
    VALUES (v_user, v_org, v_user || '@example.test', 'Read scope fixture', 'ops_admin', 'active', 'tenant');
  INSERT INTO pg_temp.read_scope_rows VALUES (v_row, v_org, 'Fixture');

  SELECT policy INTO v_policy FROM public.resolve_access_control_policy_v1('tenant', v_org, false);
  SELECT version INTO v_schema FROM public.schema_registry
  WHERE category = 'access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
  v_policy := jsonb_set(v_policy, '{roles}', v_policy->'roles' || jsonb_build_array(jsonb_build_object(
    'key', v_role, 'capability_keys', jsonb_build_array('webhooks.read'))));
  v_policy := jsonb_set(v_policy, '{assignments}', COALESCE(v_policy->'assignments', '{}'::jsonb) || jsonb_build_object(
    'user_id', COALESCE(v_policy#>'{assignments,user_id}', '{}'::jsonb) || jsonb_build_object(v_user::text, jsonb_build_array(v_role))));
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org, v_policy, v_schema, 'Read-scope guard fixture');
  SET CONSTRAINTS ALL IMMEDIATE;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  RETURN NEXT is(public.ui_list_resource_v1('qa_read_scope_guard')#>>'{items,0,id}', v_row::text, 'list scope allowed');
  RETURN NEXT is(public.ui_get_resource_v1('qa_read_scope_guard', v_row)->>'id', v_row::text, 'get scope allowed');
  RETURN NEXT is(public.ui_resource_metrics_v1('qa_read_scope_guard')->>'total', '1', 'metrics scope allowed');
  RETURN NEXT is(public.ui_filter_distinct_values_v1('qa_read_scope_guard', 'name'), '["Fixture"]'::jsonb, 'distinct scope allowed');

  FOR v_scope, v_scope_id IN
    SELECT * FROM (VALUES ('client', v_client), ('sender', v_sender), ('platform', NULL::uuid)) AS scopes(scope_type, scope_id)
  LOOP
    SET LOCAL ROLE postgres;
    UPDATE public.users SET access_scope_type = v_scope, access_scope_id = v_scope_id WHERE id = v_user;
    SET LOCAL ROLE authenticated;
    RETURN NEXT throws_ok($sql$SELECT public.ui_list_resource_v1('qa_read_scope_guard')$sql$,
      '42501', 'Resource read scope denied', 'list scope denied: ' || v_scope);
    RETURN NEXT throws_ok(format('SELECT public.ui_get_resource_v1(%L, %L::uuid)', 'qa_read_scope_guard', v_row),
      '42501', 'Resource read scope denied', 'get scope denied: ' || v_scope);
    RETURN NEXT throws_ok($sql$SELECT public.ui_resource_metrics_v1('qa_read_scope_guard')$sql$,
      '42501', 'Resource read scope denied', 'metrics scope denied: ' || v_scope);
    RETURN NEXT throws_ok($sql$SELECT public.ui_filter_distinct_values_v1('qa_read_scope_guard', 'name')$sql$,
      '42501', 'Resource read scope denied', 'distinct scope denied: ' || v_scope);
  END LOOP;
  SET LOCAL ROLE postgres;
END;
$test$;

SELECT * FROM pg_temp.test_ui_read_scope_guard_v1();
SELECT * FROM finish();
ROLLBACK;
