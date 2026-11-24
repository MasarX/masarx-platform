BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT ok((
  SELECT proowner='ui_rpc_executor'::regrole FROM pg_proc
  WHERE oid='public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure
) AND NOT has_schema_privilege('ui_rpc_executor', 'public', 'CREATE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid='ui_rpc_executor'::regrole
      AND (COALESCE((to_jsonb(pg_auth_members)->>'inherit_option')::boolean, true)
        OR COALESCE((to_jsonb(pg_auth_members)->>'set_option')::boolean, true))
  ), 'the bounded count retains its executor owner without replacement authority');

CREATE TABLE public.ui_test_scoped_log_totals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
);
ALTER TABLE public.ui_test_scoped_log_totals ENABLE ROW LEVEL SECURITY;
CREATE POLICY visible_logs ON public.ui_test_scoped_log_totals FOR SELECT TO ui_rpc_executor
  USING (organization_id = public.current_user_org_id());
GRANT SELECT ON public.ui_test_scoped_log_totals TO ui_rpc_executor;

CREATE FUNCTION pg_temp.check_scoped_log_totals()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  tenant_id uuid := gen_random_uuid();
  other_tenant_id uuid := gen_random_uuid();
  actor_id uuid := gen_random_uuid();
  registry jsonb;
  schema_version integer;
  started_at timestamptz;
  result jsonb;
  resource_key constant text := 'ui_test_scoped_log_totals';
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES (tenant_id, 'Synthetic log tenant', 'log-fixture-' || tenant_id, 'active');
  PERFORM set_config('app.organization_onboarding_source', '', true);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (actor_id, tenant_id, actor_id || '@example.test', 'Synthetic log reader', 'ops_admin', 'active', 'tenant');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', actor_id)::text, true);
  PERFORM set_config('request.jwt.claim.sub', actor_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  SELECT sv.value, sv.schema_version INTO STRICT registry, schema_version
  FROM public.settings s JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_read_registry' AND s.scope_type = 'global' AND s.scope_id IS NULL;
  RETURN NEXT is((
    SELECT count(*) FROM jsonb_array_elements(registry->'resources') AS entry(value)
    WHERE value->>'key' IN ('decision_log', 'settings_resolution_log', 'webhook_inbox')
      AND value->>'total_strategy' = 'exact_then_estimate'
  ), 3::bigint, 'the three log resources opt into bounded exact totals');

  registry := jsonb_set(registry, '{resources}', registry->'resources' || jsonb_build_array(
    jsonb_build_object(
      'key', resource_key, 'label', 'Synthetic scoped logs', 'relation', 'public.ui_test_scoped_log_totals',
      'id_column', 'id', 'select', jsonb_build_array('id', 'organization_id'),
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'total_strategy', 'exact_then_estimate'
    )
  ));
  PERFORM public.upsert_settings_value_v1('ui_read_registry', 'global', NULL, registry, schema_version,
    'Rollback-only log total fixture');
  PERFORM public.upsert_settings_value_v1('ui_read_registry', 'tenant', tenant_id, registry, schema_version,
    'Rollback-only tenant log total fixture');

  INSERT INTO public.ui_test_scoped_log_totals (organization_id)
  SELECT other_tenant_id FROM generate_series(1, 1500);
  INSERT INTO public.ui_test_scoped_log_totals (organization_id) VALUES (tenant_id), (tenant_id);

  result := public.ui_list_resource_v1(resource_key, '{}'::jsonb, 10, 0, NULL);
  RETURN NEXT is(result->>'total', '2', 'invisible logs do not inflate the exact scoped count');
  RETURN NEXT is(result->>'total_strategy', 'exact', 'a small scoped log total stays exact');
  RETURN NEXT is(result->>'total_is_estimate', 'false', 'a small scoped count is marked exact');

  INSERT INTO public.ui_test_scoped_log_totals (organization_id)
  SELECT tenant_id FROM generate_series(1, 20000);
  ANALYZE public.ui_test_scoped_log_totals;
  started_at := clock_timestamp();
  result := public.ui_list_resource_v1(resource_key, '{}'::jsonb, 10, 0, NULL);
  RAISE NOTICE 'Scoped list with 20002 synthetic visible rows: % ms',
    round(extract(epoch FROM clock_timestamp() - started_at) * 1000, 2);
  RETURN NEXT is(result->>'total_strategy', 'estimate', 'a large scoped log count uses the planner estimate');
  RETURN NEXT is(result->>'total_is_estimate', 'true', 'a large scoped count is marked approximate');
  RETURN NEXT is((
    SELECT count(*) FROM jsonb_array_elements(result->'items') AS item(value)
    WHERE value->>'organization_id' = tenant_id::text
  ), 10::bigint, 'the large-list page contains only the caller tenant rows');
END;
$test$;

SELECT * FROM pg_temp.check_scoped_log_totals();
SELECT * FROM finish();
ROLLBACK;
