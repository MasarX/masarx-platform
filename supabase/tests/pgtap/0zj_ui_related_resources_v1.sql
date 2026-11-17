-- Test Suite: ui_related_resources_v1 + dynamic list filters
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

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

-- Arrange: append resources to ui_read_registry cached_value (test-only; rolled back)
DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_append JSONB := jsonb_build_array(
    jsonb_build_object(
      'key','ui_test_parent',
      'label','UI test parent',
      'relation','public.ui_test_parent',
      'id_column','id'
    ),
    jsonb_build_object(
      'key','ui_test_child',
      'label','UI test child',
      'relation','public.ui_test_child',
      'id_column','id',
      'filters', jsonb_build_array()
    ),
    jsonb_build_object(
      'key','ui_test_parent_comp',
      'label','UI test parent comp',
      'relation','public.ui_test_parent_comp',
      'id_column','id'
    ),
    jsonb_build_object(
      'key','ui_test_child_comp',
      'label','UI test child comp',
      'relation','public.ui_test_child_comp',
      'id_column','id',
      'filters', jsonb_build_array()
    )
  );
BEGIN
  SELECT cached_value
    INTO v_current
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb) || v_append;
  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  UPDATE public.settings
  SET cached_value = v_current,
      last_updated = now()
  WHERE category = 'ui_read_registry'
    AND scope_type = 'global'
    AND scope_id IS NULL;
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
