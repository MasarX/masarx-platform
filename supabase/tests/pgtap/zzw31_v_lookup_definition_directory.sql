-- pgTAP: public.v_lookup_definition_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W31 (paired projection views - CATALOG)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_lookup_definition_directory',
  'public.v_lookup_definition_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_lookup_definition_directory',
  ARRAY[
    'id', 'category', 'description', 'owner_role', 'approval_policy',
    'is_mutable', 'created_by', 'created_at', 'updated_at',
    'value_count', 'active_value_count', 'draft_value_count',
    'archived_value_count', 'retired_value_count',
    'default_value', 'default_value_label', 'has_default',
    'last_value_updated_at',
    'age_seconds', 'age_hours', 'last_updated_at'
  ],
  'v_lookup_definition_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_lookup_definition_directory', 'SELECT'),
  'service_role has SELECT on v_lookup_definition_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_lookup_definition_directory', 'SELECT'),
  'anon has no SELECT on v_lookup_definition_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_lookup_definition_directory', 'SELECT'),
  'authenticated has SELECT on v_lookup_definition_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'lookup_definitions'
       AND c.relkind = 'r'
  ),
  'public.lookup_definitions remains a base table (SSOT preserved)'
);

-- 7) Projection: insert lookup_definition + values.
DO $$
DECLARE
  v_def      UUID := '00000000-0000-0000-0000-00000031c001';
  v_v1       UUID := '00000000-0000-0000-0000-00000031c002';
  v_v2       UUID := '00000000-0000-0000-0000-00000031c003';
  v_v3       UUID := '00000000-0000-0000-0000-00000031c004';
  v_v4       UUID := '00000000-0000-0000-0000-00000031c005';
  v_v5       UUID := '00000000-0000-0000-0000-00000031c006';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.lookup_definitions (
    id, category, description, owner_role, approval_policy, is_mutable
  )
  VALUES (
    v_def, 'w31_lookup_test_main',
    'W31 lookup definition for projection test',
    'operations', 'tier_1', TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_values (
    id, lookup_definition_id, value, label, sort_order, is_default, status
  )
  VALUES
    (v_v1, v_def, 'w31_a', 'Alpha',   1, TRUE,  'active'),
    (v_v2, v_def, 'w31_b', 'Beta',    2, FALSE, 'active'),
    (v_v3, v_def, 'w31_c', 'Charlie', 3, FALSE, 'active'),
    (v_v4, v_def, 'w31_d', 'Delta',   4, FALSE, 'draft'),
    (v_v5, v_def, 'w31_e', 'Echo',    5, FALSE, 'archived')
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.lookup_values
     SET retired_at = now()
   WHERE id = v_v5;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_lookup_definition_directory
    WHERE id = '00000000-0000-0000-0000-00000031c001'::UUID
      AND value_count = 5
      AND active_value_count = 3
      AND draft_value_count = 1
      AND archived_value_count = 1
      AND retired_value_count = 1
      AND default_value = 'w31_a'
      AND default_value_label = 'Alpha'
      AND has_default = TRUE
  ),
  'v_lookup_definition_directory derives value_count=5 + active/draft/archived/retired splits + default_value/label/has_default for the is_default=TRUE row (sort_order asc)'
);

-- 8) No-default projection.
DO $$
DECLARE
  v_def2     UUID := '00000000-0000-0000-0000-00000031c020';
  v_v_only   UUID := '00000000-0000-0000-0000-00000031c021';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.lookup_definitions (
    id, category, is_mutable
  )
  VALUES (
    v_def2, 'w31_lookup_no_default_main', TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.lookup_values (
    id, lookup_definition_id, value, label, status, is_default
  )
  VALUES (
    v_v_only, v_def2, 'w31_only', 'Only', 'active', FALSE
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_lookup_definition_directory
    WHERE id = '00000000-0000-0000-0000-00000031c020'::UUID
      AND default_value IS NULL
      AND has_default = FALSE
      AND value_count = 1
  ),
  'v_lookup_definition_directory: definition with zero is_default=TRUE rows resolves default_value=NULL + has_default=FALSE while value_count remains accurate'
);

SELECT * FROM finish();
ROLLBACK;
