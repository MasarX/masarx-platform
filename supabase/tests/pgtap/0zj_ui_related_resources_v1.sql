-- Test Suite: ui_related_resources_v1 + dynamic list filters
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

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


-- Arrange: Minimal tables with RLS + FK
CREATE TABLE public.ui_test_parent (
  id UUID PRIMARY KEY,
  name TEXT
);

ALTER TABLE public.ui_test_parent ENABLE ROW LEVEL SECURITY;
CREATE POLICY ui_test_parent_select ON public.ui_test_parent
  FOR SELECT USING (TRUE);

CREATE TABLE public.ui_test_child (
  id UUID PRIMARY KEY,
  parent_id UUID REFERENCES public.ui_test_parent(id),
  name TEXT
);

ALTER TABLE public.ui_test_child ENABLE ROW LEVEL SECURITY;
CREATE POLICY ui_test_child_select ON public.ui_test_child
  FOR SELECT USING (TRUE);

CREATE TABLE public.ui_test_parent_comp (
  id UUID NOT NULL,
  client_id UUID NOT NULL,
  name TEXT,
  PRIMARY KEY (id, client_id)
);

ALTER TABLE public.ui_test_parent_comp ENABLE ROW LEVEL SECURITY;
CREATE POLICY ui_test_parent_comp_select ON public.ui_test_parent_comp
  FOR SELECT USING (TRUE);

CREATE TABLE public.ui_test_child_comp (
  id UUID PRIMARY KEY,
  parent_id UUID NOT NULL,
  parent_client_id UUID NOT NULL,
  name TEXT,
  CONSTRAINT ui_test_child_comp_parent_fk
    FOREIGN KEY (parent_id, parent_client_id)
    REFERENCES public.ui_test_parent_comp(id, client_id)
);

ALTER TABLE public.ui_test_child_comp ENABLE ROW LEVEL SECURITY;
CREATE POLICY ui_test_child_comp_select ON public.ui_test_child_comp
  FOR SELECT USING (TRUE);

INSERT INTO public.ui_test_parent (id, name)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'parent-1'),
  ('00000000-0000-0000-0000-000000000002', 'parent-2');

INSERT INTO public.ui_test_parent_comp (id, client_id, name)
VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000c001', 'parent-comp-1'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000c002', 'parent-comp-2');

INSERT INTO public.ui_test_child (id, parent_id, name)
VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'child-1'),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000002', 'child-2');

INSERT INTO public.ui_test_child_comp (id, parent_id, parent_client_id, name)
VALUES
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000c001', 'child-comp-1'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000c002', 'child-comp-2');

GRANT SELECT ON public.ui_test_parent, public.ui_test_child, public.ui_test_parent_comp, public.ui_test_child_comp TO ui_rpc_executor;

-- Arrange: append resources to ui_read_registry cached_value (test-only; rolled back)
DO $$
DECLARE
  v_current JSONB;
  v_schema INTEGER;
  v_resources JSONB;
  v_append JSONB := jsonb_build_array(
    jsonb_build_object(
      'key','ui_test_parent',
      'label','UI test parent',
      'relation','public.ui_test_parent',
      'select',jsonb_build_array('id','name'),
      'id_column','id'
    ),
    jsonb_build_object(
      'key','ui_test_child',
      'label','UI test child',
      'relation','public.ui_test_child',
      'select',jsonb_build_array('id','parent_id','name'),
      'id_column','id',
      'filters', jsonb_build_array()
    ),
    jsonb_build_object(
      'key','ui_test_parent_comp',
      'label','UI test parent comp',
      'relation','public.ui_test_parent_comp',
      'select',jsonb_build_array('id','client_id','name'),
      'id_column','id'
    ),
    jsonb_build_object(
      'key','ui_test_child_comp',
      'label','UI test child comp',
      'relation','public.ui_test_child_comp',
      'select',jsonb_build_array('id','parent_id','parent_client_id','name'),
      'id_column','id',
      'filters', jsonb_build_array()
    )
  );
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

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb) || v_append;
  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,v_current,v_schema,
    'Rollback-only UI executor fixture resources');
  PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',public.current_user_org_id(),v_current,v_schema,
    'Rollback-only UI executor fixture presentation');
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.ui_related_resources_v1('ui_test_parent', 10)) AS value
    WHERE value->>'resource' = 'ui_test_child'
      AND value->>'filter_key' = 'parent_id'
      AND value->>'from' = 'id'
  ),
  'ui_related_resources_v1 returns fk-related child resources'
);

SELECT is(
  (public.ui_list_resource_v1(
    'ui_test_child',
    jsonb_build_object('parent_id','00000000-0000-0000-0000-000000000001'),
    50,
    0,
    NULL
  )->>'total')::int,
  1,
  'ui_list_resource_v1 applies dynamic column filters'
);

SELECT is(
  (public.ui_list_resource_v1(
    'ui_test_child',
    jsonb_build_object('parent_id','00000000-0000-0000-0000-000000000001'),
    50,
    0,
    NULL
  )->'items'->0->>'id'),
  '00000000-0000-0000-0000-000000000101',
  'ui_list_resource_v1 returns expected row for dynamic filter'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.ui_related_resources_v1('ui_test_parent_comp', 10)) AS value
    WHERE value->>'resource' = 'ui_test_child_comp'
      AND value->'filter_key' = '["parent_id","parent_client_id"]'::jsonb
      AND value->'from' = '["id","client_id"]'::jsonb
  ),
  'ui_related_resources_v1 returns composite fk mappings'
);

SELECT is(
  (public.ui_list_resource_v1(
    'ui_test_child_comp',
    jsonb_build_object(
      'parent_id','00000000-0000-0000-0000-000000000001',
      'parent_client_id','00000000-0000-0000-0000-00000000c001'
    ),
    50,
    0,
    NULL
  )->'items'->0->>'id'),
  '00000000-0000-0000-0000-000000000201',
  'ui_list_resource_v1 returns expected row for composite filter'
);

SELECT finish();

ROLLBACK;
