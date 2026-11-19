BEGIN;

SELECT plan(12);

SELECT ok(
  position(
    'tabular_import_prepare_v1.timeout_window_v1'
    IN pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
  ) > 0,
  'tabular_import_prepare_v1 records the bounded browser prepare timeout patch'
);

SELECT ok(
  position(
    'set_config(''statement_timeout'', ''30000'', true)'
    IN pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
  ) > 0,
  'tabular_import_prepare_v1 allows a bounded 30 second prepare window'
);

SELECT ok(
  position(
    'SET statement_timeout TO ''30s'''
    IN pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
  ) > 0,
  'tabular_import_prepare_v1 applies the timeout on function entry'
);

SELECT ok(
  position(
    'SET statement_timeout TO ''30s'''
    IN pg_get_functiondef('api.tabular_import_prepare_v1(jsonb)'::regprocedure)
  ) > 0,
  'api.tabular_import_prepare_v1 applies the same timeout contract used by the browser edge path'
);

SELECT ok(
  position(
    'tabular_import_prepare_v1.reuse_registry_v1'
    IN pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
  ) > 0,
  'tabular_import_prepare_v1 reuses the already loaded registry for resource resolution'
);

SELECT has_function(
  'public',
  'ui_match_tabular_import_profile_v1',
  ARRAY['text', 'jsonb', 'text'],
  'public.ui_match_tabular_import_profile_v1 exists for direct profile matching'
);

SELECT has_function(
  'api',
  'ui_match_tabular_import_profile_v1',
  ARRAY['text', 'jsonb', 'text'],
  'api.ui_match_tabular_import_profile_v1 exists for browser-safe direct profile matching'
);

SELECT ok(
  to_regclass('public.idx_mapping_configs_tabular_import_profile_match') IS NOT NULL,
  'mapping_configs has a scoped tabular import profile-match index'
);

SELECT ok(
  position(
    'tabular_import_prepare_v1.profile_match_fast_path_v1'
    IN pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
  ) > 0,
  'tabular_import_prepare_v1 uses the indexed direct profile-match fast path'
);

SELECT ok(
  position(
    'tabular_import_prepare_v1.fast_prepare_readback_v1'
    IN pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
  ) > 0,
  'tabular_import_prepare_v1 uses lightweight prepare readback inside the prepare RPC'
);

SELECT ok(
  position(
    'public.ui_get_tabular_import_run_v1'
    IN pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
  ) = 0,
  'tabular_import_prepare_v1 leaves canonical drawer readback to the separate Console backend readback step'
);

SELECT ok(
  position(
    'SET statement_timeout TO ''30s'''
    IN pg_get_functiondef('public.ui_match_tabular_import_profile_v1(text,jsonb,text)'::regprocedure)
  ) > 0,
  'ui_match_tabular_import_profile_v1 has a bounded function-level timeout for edge preflight'
);

SELECT * FROM finish();

ROLLBACK;
