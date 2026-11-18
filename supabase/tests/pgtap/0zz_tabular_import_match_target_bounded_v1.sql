BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.tabular_import_match_target_v1(text,text,jsonb,text[])',
    'EXECUTE'
  ),
  'anon cannot execute the dynamic target matcher'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.tabular_import_match_target_v1(text,text,jsonb,text[])',
    'EXECUTE'
  ),
  'authenticated cannot execute the dynamic target matcher'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.tabular_import_match_target_v1(text,text,jsonb,text[])',
    'EXECUTE'
  ),
  'service role can execute the internal target matcher'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.tabular_import_stage_related_nodes_v1(uuid,jsonb,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute the related-node staging helper'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.tabular_import_stage_related_nodes_v1(uuid,jsonb,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute the related-node staging helper'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.tabular_import_stage_related_nodes_v1(uuid,jsonb,jsonb)',
    'EXECUTE'
  ),
  'service role can execute the internal related-node staging helper'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.tabular_import_prepare_v1(jsonb)', 'EXECUTE'),
  'authenticated retains the governed tabular import prepare wrapper'
);

CREATE TABLE public.tabular_import_match_target_probe (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  external_key TEXT NOT NULL
);

INSERT INTO public.tabular_import_match_target_probe (id, organization_id, external_key)
VALUES
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'one'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'duplicate'),
  ('10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'duplicate'),
  ('10000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000002', 'one');

SELECT is(
  (public.tabular_import_match_target_v1(
    'public.tabular_import_match_target_probe',
    'id',
    '{"organization_id":"20000000-0000-0000-0000-000000000001","external_key":"missing"}'::jsonb,
    ARRAY['external_key']
  )->>'match_count')::int,
  0,
  'missing identity returns zero matches'
);

SELECT is(
  public.tabular_import_match_target_v1(
    'public.tabular_import_match_target_probe',
    'id',
    '{"organization_id":"20000000-0000-0000-0000-000000000001","external_key":"one"}'::jsonb,
    ARRAY['external_key']
  )->>'target_record_id',
  '10000000-0000-0000-0000-000000000001',
  'identity plus scope resolves the one canonical row'
);

SELECT is(
  (public.tabular_import_match_target_v1(
    'public.tabular_import_match_target_probe',
    'id',
    '{"organization_id":"20000000-0000-0000-0000-000000000001","external_key":"duplicate"}'::jsonb,
    ARRAY['external_key']
  )->>'match_count')::int,
  2,
  'ambiguous identity stops after two matches'
);

SELECT is(
  public.tabular_import_match_target_v1(
    'public.tabular_import_match_target_probe',
    'id',
    '{"organization_id":"20000000-0000-0000-0000-000000000002","external_key":"one"}'::jsonb,
    ARRAY['external_key']
  )->>'target_record_id',
  '10000000-0000-0000-0000-000000000004',
  'scope equality excludes the same identity in another organization'
);

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$
    SELECT public.tabular_import_match_target_v1(
      'public.tabular_import_match_target_probe',
      'id',
      '{"external_key":"one"}'::jsonb,
      ARRAY['external_key']
    )
  $$,
  '42501',
  'permission denied for function tabular_import_match_target_v1',
  'authenticated hostile calls cannot reach the dynamic target matcher'
);
SELECT throws_ok(
  $$
    SELECT public.tabular_import_stage_related_nodes_v1(
      '10000000-0000-0000-0000-000000000001'::uuid,
      '[]'::jsonb,
      '[]'::jsonb
    )
  $$,
  '42501',
  'permission denied for function tabular_import_stage_related_nodes_v1',
  'authenticated hostile calls cannot reach related-node staging'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
