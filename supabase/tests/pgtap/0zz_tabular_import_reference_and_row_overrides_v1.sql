BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_function(
  'public',
  'ui_read_registry_enrich_reference_import_v1',
  ARRAY['jsonb'],
  'public.ui_read_registry_enrich_reference_import_v1 exists'
);

SELECT has_function(
  'public',
  'tabular_import_materialize_row_overrides_v1',
  ARRAY['jsonb'],
  'public.tabular_import_materialize_row_overrides_v1 exists'
);

SELECT has_function(
  'public',
  'tabular_import_prepare_v1',
  ARRAY['jsonb'],
  'public.tabular_import_prepare_v1 exists after row override wrapper update'
);

SELECT has_function(
  'public',
  'ui_resolve_import_scope_context_v1',
  ARRAY['jsonb'],
  'public.ui_resolve_import_scope_context_v1 exists'
);

SELECT has_function(
  'public',
  'ui_tabular_import_profiles_v1',
  ARRAY['text', 'jsonb'],
  'public.ui_tabular_import_profiles_v1(text, jsonb) exists for scope-aware profile lookup'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS resource(value)
      JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_value(value) ON TRUE
     WHERE resource.value->>'key' = 'recipients'
       AND column_value.value->>'key' = 'client_id'
       AND COALESCE(column_value.value#>>'{import,reference,resource}', '') = 'clients'
  ),
  'ui_read_registry_v1 exposes recipients.client_id as a clients reference'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS resource(value)
      JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_value(value) ON TRUE
     WHERE resource.value->>'key' = 'shipments'
       AND column_value.value->>'key' = 'sender_id'
       AND COALESCE(column_value.value#>>'{import,reference,resource}', '') = 'senders'
  ),
  'ui_read_registry_v1 exposes shipments.sender_id as a senders reference'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = 'tabular_import_materialize_row_overrides_v1'
      AND pg_get_function_result(oid) = 'jsonb'
  ),
  'row override materialization keeps a JSONB-to-JSONB wrapper contract'
);

SELECT * FROM finish();

ROLLBACK;
