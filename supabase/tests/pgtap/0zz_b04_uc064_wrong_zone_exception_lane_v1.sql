SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT has_index(
  'public',
  'mis_sort_exceptions',
  'idx_mis_sort_exceptions_reason_detected',
  'mis_sort_exceptions has reason/detected index for wrong-zone lane'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND resource->>'key' = 'wrong_zone_exceptions'
       AND resource->>'relation' = 'public.mis_sort_exceptions'
       AND resource#>>'{base_filter,rules,0,key}' = 'exception_reason'
       AND resource#>>'{base_filter,rules,0,op}' = 'eq'
       AND resource#>>'{base_filter,rules,0,value}' = 'wrong_zone'
  ),
  'ui_read_registry exposes wrong_zone_exceptions as a base-filtered alias over mis_sort_exceptions'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS command
     WHERE s.category = 'ui_command_registry'
       AND command->>'key' = 'wrong_zone_exceptions.resolve_reassign'
       AND command#>>'{execution,rpc}' = 'ui_execute_mis_sort_exception_resolve_v1'
       AND command->>'schema_category' = 'resource:wrong_zone_exceptions'
  ),
  'ui_command_registry exposes the wrong-zone resolve command on the dedicated RPC'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_each(COALESCE(sv.value->'resource_map', '{}'::jsonb)) AS resource_map(resource_key, resource_value)
     WHERE s.category = 'access_control_policy'
       AND resource_map.resource_key = 'wrong_zone_exceptions'
       AND resource_map.resource_value->>'read' = 'baskets.read'
       AND resource_map.resource_value->>'write' = 'baskets.write'
  ),
  'access_control_policy wires wrong_zone_exceptions through baskets capabilities'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE s.category = 'ui_navigation'
       AND item->>'resource' = 'wrong_zone_exceptions'
       AND item->>'href' = '/console/operations/exceptions/wrong_zone_exceptions'
  ),
  'ui_navigation exposes the console wrong-zone exceptions lane'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,portal,sections}', '[]'::jsonb)) AS section
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE s.category = 'ui_navigation'
       AND item->>'resource' = 'wrong_zone_exceptions'
       AND item->>'href' = '/portal/operations/exceptions/wrong_zone_exceptions'
  ),
  'ui_navigation exposes the portal wrong-zone exceptions lane'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND resource->>'key' = 'wrong_zone_exceptions'
       AND resource#>>'{column_labels,actual_zone_id}' = 'Actual zone'
       AND resource#>>'{column_labels,expected_zone_id}' = 'Expected zone'
  ),
  'wrong-zone lane keeps zone-focused column labels for exception triage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mis_sort_exceptions mse
     WHERE FALSE
  ) IS NOT NULL,
  'wrong-zone pgTap file reached runtime after schema load'
);

SELECT * FROM finish();

ROLLBACK;
