-- pgTAP: ui_list_resource_v1 total_strategy (exact|estimate) + ui_read_registry defaults
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

-- Explicit rollback-owned caller; SQL session identity is not UI authorization.
DO $caller$
DECLARE v_org UUID := gen_random_uuid(); v_actor UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations(id,name,slug,billing_status)
    VALUES(v_org,'UI fixture caller','ui-fixture-'||v_org,'active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
    VALUES(v_actor,v_org,v_actor||'@example.test','UI fixture caller','ops_admin','active','tenant',NULL);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',v_actor)::text,TRUE);
  PERFORM set_config('request.jwt.claim.sub',v_actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
END;
$caller$;


SELECT ok(
  (
    SELECT p.provolatile = 'v'
      FROM pg_proc p
     WHERE p.oid = 'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure
  ),
  'ui_list_resource_v1 is volatile because estimate totals execute EXPLAIN'
);

-- ui_read_registry defaults: high-volume resources should use estimated totals (row-driven; avoids COUNT(*) timeouts)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS resource(resource_value)
          WHERE resource.resource_value->>'key' = 'audit_table_changes'
            AND resource.resource_value->>'total_strategy' = 'estimate'
       )
  ),
  'ui_read_registry: audit_table_changes uses total_strategy=estimate'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS resource(resource_value)
          WHERE resource.resource_value->>'key' = 'webhook_log'
            AND resource.resource_value->>'total_strategy' = 'estimate'
       )
  ),
  'ui_read_registry: webhook_log uses total_strategy=estimate'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS resource(resource_value)
          WHERE resource.resource_value->>'key' = 'api_call_log'
            AND resource.resource_value->>'total_strategy' = 'estimate'
       )
  ),
  'ui_read_registry: api_call_log uses total_strategy=estimate'
);

SELECT is(
  (
    SELECT p.provolatile
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)')
  ),
  'v',
  'ui_list_resource_v1 stays VOLATILE so estimate totals can use EXPLAIN'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource(resource_value)
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource.resource_value->>'key' = 'shipments'
       AND resource.resource_value->>'total_strategy' = 'estimate'
  ),
  'ui_read_registry: shipments uses total_strategy=estimate'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource(resource_value)
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource.resource_value->>'key' = 'shipments'
       AND resource.resource_value->>'estimate_filtered_totals' = 'false'
  ),
  'ui_read_registry: shipments disables estimated totals for caller filters'
);

-- ui_list_resource_v1 behavior: total_is_estimate is surfaced and totals are derived from EXPLAIN for estimate strategy
CREATE TABLE public.ui_test_total_strategy (
  id UUID PRIMARY KEY,
  name TEXT
);

ALTER TABLE public.ui_test_total_strategy ENABLE ROW LEVEL SECURITY;
CREATE POLICY ui_test_total_strategy_select ON public.ui_test_total_strategy
  FOR SELECT USING (TRUE);

INSERT INTO public.ui_test_total_strategy (id, name)
VALUES ('00000000-0000-0000-0000-00000000aa01', 'row-1');

GRANT SELECT ON public.ui_test_total_strategy TO ui_rpc_executor;

ANALYZE public.ui_test_total_strategy;

CREATE FUNCTION pg_temp.ui_total_strategy_assertions() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_current JSONB;
  v_schema INTEGER;
  v_resources JSONB;
  v_filtered_result JSONB;
  v_unfiltered_result JSONB;
BEGIN
  SELECT sv.value, sv.schema_version
    INTO v_current, v_schema
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id AND sv.scope_hash=s.scope_hash
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'key','ui_test_total_strategy',
      'label','UI test total strategy',
      'relation','public.ui_test_total_strategy',
      'select',jsonb_build_array('id','name'),
      'id_column','id',
      'total_strategy','estimate',
      'estimate_filtered_totals', false
    )
  );

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_current,v_schema,
    'Rollback-only UI executor fixture resources');
  PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',public.current_user_org_id(),v_current,v_schema,
    'Rollback-only UI executor fixture presentation');

  v_unfiltered_result := public.ui_list_resource_v1(
    'ui_test_total_strategy',
    '{}'::jsonb,
    50,
    0,
    NULL
  );

  RETURN NEXT is(v_unfiltered_result->>'total_strategy', 'estimate', 'ui_list_resource_v1 returns total_strategy=estimate for unfiltered estimate resources');
  RETURN NEXT ok((v_unfiltered_result->>'total_is_estimate')::boolean, 'ui_list_resource_v1 returns total_is_estimate=true for unfiltered estimate resources');
  RETURN NEXT is((v_unfiltered_result->>'total')::int, 1, 'ui_list_resource_v1 estimate total matches unfiltered small table');

  v_filtered_result := public.ui_list_resource_v1(
    'ui_test_total_strategy',
    jsonb_build_object('id', '00000000-0000-0000-0000-00000000aa01'),
    50,
    0,
    NULL
  );

  RETURN NEXT is(v_filtered_result->>'total_strategy', 'exact', 'ui_list_resource_v1 falls back to exact totals for filtered estimate resources when disabled');
  RETURN NEXT ok(NOT (v_filtered_result->>'total_is_estimate')::boolean, 'ui_list_resource_v1 returns total_is_estimate=false for filtered exact fallback');
  RETURN NEXT is((v_filtered_result->>'total')::int, 1, 'ui_list_resource_v1 exact fallback total matches filtered PK equality');
END $$;

SELECT * FROM pg_temp.ui_total_strategy_assertions();

SELECT finish();

ROLLBACK;

