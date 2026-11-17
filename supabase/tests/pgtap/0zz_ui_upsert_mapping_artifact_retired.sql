BEGIN;

SELECT plan(2);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_upsert_mapping_artifact_v1'
  ),
  1,
  'public.ui_upsert_mapping_artifact_v1 keeps only the canonical overload'
);

SELECT has_function(
  'public',
  'ui_upsert_mapping_artifact_v1',
  ARRAY['jsonb'],
  'canonical public.ui_upsert_mapping_artifact_v1(jsonb) exists'
);

SELECT * FROM finish();
ROLLBACK;
