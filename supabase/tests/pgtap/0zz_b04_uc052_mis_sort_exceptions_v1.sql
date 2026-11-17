SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT has_table('public', 'mis_sort_exceptions', 'public.mis_sort_exceptions exists');
SELECT has_view('api', 'mis_sort_exceptions', 'api.mis_sort_exceptions exists');

SELECT has_function(
  'public',
  'resolve_mis_sort_exception_v1',
  ARRAY['uuid', 'jsonb'],
  'public.resolve_mis_sort_exception_v1 exists'
);

SELECT has_function(
  'public',
  'ui_execute_mis_sort_exception_resolve_v1',
  ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
  'public.ui_execute_mis_sort_exception_resolve_v1 exists'
);

SELECT has_function(
  'api',
  'ui_execute_mis_sort_exception_resolve_v1',
  ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
  'api.ui_execute_mis_sort_exception_resolve_v1 exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'api'
       AND c.relname = 'mis_sort_exceptions'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'api.mis_sort_exceptions is security_invoker'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.mis_sort_exceptions', 'SELECT'),
  'authenticated can SELECT public.mis_sort_exceptions'
);

SELECT ok(
  has_table_privilege('authenticated', 'api.mis_sort_exceptions', 'SELECT'),
  'authenticated can SELECT api.mis_sort_exceptions'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_execute_mis_sort_exception_resolve_v1(text, text, text[], text, integer, jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_execute_mis_sort_exception_resolve_v1'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND resource->>'key' = 'mis_sort_exceptions'
     LIMIT 1
  ),
  'public.mis_sort_exceptions',
  'ui_read_registry points mis_sort_exceptions at the RLS-backed public table'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS command
     WHERE s.category = 'ui_command_registry'
       AND command->>'key' = 'mis_sort_exceptions.resolve_reassign'
       AND command#>>'{execution,rpc}' = 'ui_execute_mis_sort_exception_resolve_v1'
  ),
  'ui_command_registry exposes the dedicated mis-sort resolve RPC'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE s.category = 'ui_navigation'
       AND item->>'resource' = 'mis_sort_exceptions'
  ),
  'ui_navigation exposes the mis_sort_exceptions lane'
);

SELECT * FROM finish();

ROLLBACK;
