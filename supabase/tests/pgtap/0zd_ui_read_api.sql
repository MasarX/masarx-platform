-- Test Suite: UI read API registry + RPC presence
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(64);

SELECT has_function('public', 'ui_me_v1', ARRAY[]::text[], 'ui_me_v1 exists');
SELECT has_function('public', 'ui_navigation_v1', ARRAY['text'], 'ui_navigation_v1 exists');
SELECT has_function('public', 'ui_read_registry_v1', ARRAY[]::text[], 'ui_read_registry_v1 exists');
SELECT has_function('public', 'ui_command_registry_v1', ARRAY[]::text[], 'ui_command_registry_v1 exists');
SELECT has_function('public', 'ui_dashboard_config_v1', ARRAY[]::text[], 'ui_dashboard_config_v1 exists');
SELECT has_function('public', 'ui_filter_operators_v1', ARRAY[]::text[], 'ui_filter_operators_v1 exists');
SELECT has_function(
  'public',
  'ui_filter_distinct_values_v1',
  ARRAY['text','text','text','integer'],
  'ui_filter_distinct_values_v1 exists'
);
SELECT has_function(
  'api',
  'ui_filter_distinct_values_v1',
  ARRAY['text','text','text','integer'],
  'api.ui_filter_distinct_values_v1 exists'
);
SELECT has_function('public', 'ui_tracking_registry_v1', ARRAY[]::text[], 'ui_tracking_registry_v1 exists');
SELECT has_function('public', 'ui_list_resource_v1', ARRAY['text','jsonb','integer','integer','jsonb'], 'ui_list_resource_v1 exists');
SELECT has_function('public', 'ui_get_resource_v1', ARRAY['text','uuid'], 'ui_get_resource_v1 exists');
SELECT has_function(
  'public',
  'ui_get_workflow_run_output_status_v1',
  ARRAY['uuid','text[]'],
  'ui_get_workflow_run_output_status_v1 exists'
);
SELECT has_function(
  'api',
  'ui_get_workflow_run_output_status_v1',
  ARRAY['uuid','text[]'],
  'api.ui_get_workflow_run_output_status_v1 exists'
);
SELECT has_function('public', 'ui_get_trace_v1', ARRAY['uuid'], 'ui_get_trace_v1 exists');
SELECT has_function('public', 'ui_table_views_v1', ARRAY['text','text','uuid'], 'ui_table_views_v1 exists');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_navigation'),
  'ui_navigation category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_read_registry'),
  'ui_read_registry category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_command_registry'),
  'ui_command_registry category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_dashboard_config'),
  'ui_dashboard_config category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_filter_operators'),
  'ui_filter_operators category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_tracking_registry'),
  'ui_tracking_registry category registered'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'ui_table_views'),
  'ui_table_views category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'apps'
  ),
  'ui_navigation global defaults seeded'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_dashboard_config'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'max_sections'
  ),
  'ui_dashboard_config global defaults seeded'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_filter_operators'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'operators'
  ),
  'ui_filter_operators global defaults seeded'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_tracking_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resource_key'
  ),
  'ui_tracking_registry global defaults seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value::text LIKE '%/portal/settings/request%'
  ),
  'ui_navigation includes portal settings request'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value::text LIKE '%/portal/access-policy%'
  ),
  'ui_navigation includes portal access policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'shipments'
      )
  ),
  'ui_read_registry includes shipments'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'tasks'
      )
  ),
  'ui_read_registry includes tasks'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'recipients'
      )
  ),
  'ui_read_registry includes recipients'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'addresses'
      )
  ),
  'ui_read_registry includes addresses'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'shipment_actions'
      )
  ),
  'ui_read_registry includes shipment_actions'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'shipment_boxes'
      )
  ),
  'ui_read_registry includes shipment_boxes'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'shipment_reference_numbers'
      )
  ),
  'ui_read_registry includes shipment_reference_numbers'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'zones'
      )
  ),
  'ui_read_registry includes zones'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'webhook_sources'
      )
  ),
  'ui_read_registry includes webhook_sources'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'webhook_response_events'
      )
  ),
  'ui_read_registry excludes webhook_response_events (view is not RLS-safe)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'lookup_values'
      )
  ),
  'ui_read_registry includes lookup_values'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'label_sections'
      )
  ),
  'ui_read_registry includes label_sections'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'domain_events'
      )
  ),
  'ui_read_registry includes domain_events'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'workflow_runs'
      )
  ),
  'ui_read_registry includes workflow_runs'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'schema_registry'
      )
  ),
  'ui_read_registry includes schema_registry'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'workflow_template_steps'
          AND NOT (value ? 'select')
      )
  ),
  'ui_read_registry workflow_template_steps selects all columns'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS value
        WHERE value->>'key' = 'labels'
          AND value ? 'download'
          AND value->'download' ? 'path_column'
      )
  ),
  'ui_read_registry labels include download config'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'ui_table_views'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value ? 'resources'
  ),
  'ui_table_views global defaults seeded'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.ui_me_v1()', 'EXECUTE'),
  'authenticated can execute ui_me_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_navigation_v1(text)', 'EXECUTE'),
  'authenticated can execute ui_navigation_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_read_registry_v1()', 'EXECUTE'),
  'authenticated can execute ui_read_registry_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_command_registry_v1()', 'EXECUTE'),
  'authenticated can execute ui_command_registry_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_dashboard_config_v1()', 'EXECUTE'),
  'authenticated can execute ui_dashboard_config_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_filter_operators_v1()', 'EXECUTE'),
  'authenticated can execute ui_filter_operators_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_filter_distinct_values_v1(text,text,text,integer)',
    'EXECUTE'
  ),
  'authenticated can execute ui_filter_distinct_values_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_filter_distinct_values_v1(text,text,text,integer)',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_filter_distinct_values_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_tracking_registry_v1()', 'EXECUTE'),
  'authenticated can execute ui_tracking_registry_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute ui_list_resource_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_get_resource_v1(text,uuid)', 'EXECUTE'),
  'authenticated can execute ui_get_resource_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_get_workflow_run_output_status_v1(uuid,text[])',
    'EXECUTE'
  ),
  'authenticated can execute ui_get_workflow_run_output_status_v1'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_get_workflow_run_output_status_v1(uuid,text[])',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_get_workflow_run_output_status_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_get_trace_v1(uuid)', 'EXECUTE'),
  'authenticated can execute ui_get_trace_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_table_views_v1(text,text,uuid)', 'EXECUTE'),
  'authenticated can execute ui_table_views_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_me_v1()', 'EXECUTE'),
  'anon cannot execute ui_me_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_get_trace_v1(uuid)', 'EXECUTE'),
  'anon cannot execute ui_get_trace_v1'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_get_workflow_run_output_status_v1(uuid,text[])',
    'EXECUTE'
  ),
  'anon cannot execute ui_get_workflow_run_output_status_v1'
);

SELECT finish();

ROLLBACK;
