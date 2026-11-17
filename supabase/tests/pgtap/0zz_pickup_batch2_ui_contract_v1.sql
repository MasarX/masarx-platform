BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(40);

SELECT has_view('api', 'pickup_requests', 'api.pickup_requests view exists');
SELECT ok(has_table_privilege('authenticated', 'api.pickup_requests', 'SELECT'), 'authenticated can SELECT api.pickup_requests');
SELECT ok(has_table_privilege('service_role', 'api.pickup_requests', 'SELECT'), 'service_role can SELECT api.pickup_requests');
SELECT ok(NOT has_table_privilege('anon', 'api.pickup_requests', 'SELECT'), 'anon cannot SELECT api.pickup_requests');

SELECT has_view('api', 'pickup_waves', 'api.pickup_waves view exists');
SELECT ok(has_table_privilege('authenticated', 'api.pickup_waves', 'SELECT'), 'authenticated can SELECT api.pickup_waves');
SELECT ok(has_table_privilege('service_role', 'api.pickup_waves', 'SELECT'), 'service_role can SELECT api.pickup_waves');
SELECT ok(NOT has_table_privilege('anon', 'api.pickup_waves', 'SELECT'), 'anon cannot SELECT api.pickup_waves');

SELECT has_view('api', 'pickup_failures', 'api.pickup_failures view exists');
SELECT ok(has_table_privilege('authenticated', 'api.pickup_failures', 'SELECT'), 'authenticated can SELECT api.pickup_failures');
SELECT ok(has_table_privilege('service_role', 'api.pickup_failures', 'SELECT'), 'service_role can SELECT api.pickup_failures');
SELECT ok(NOT has_table_privilege('anon', 'api.pickup_failures', 'SELECT'), 'anon cannot SELECT api.pickup_failures');

SELECT has_function(
  'api',
  'create_pickup_request_v1',
  ARRAY['jsonb'],
  'api.create_pickup_request_v1 exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.create_pickup_request_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE api.create_pickup_request_v1(jsonb)'
);
SELECT ok(
  has_function_privilege('service_role', 'api.create_pickup_request_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE api.create_pickup_request_v1(jsonb)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.create_pickup_request_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE api.create_pickup_request_v1(jsonb)'
);

SELECT has_function(
  'api',
  'create_pickup_wave_v1',
  ARRAY['jsonb'],
  'api.create_pickup_wave_v1 exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.create_pickup_wave_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE api.create_pickup_wave_v1(jsonb)'
);
SELECT ok(
  has_function_privilege('service_role', 'api.create_pickup_wave_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE api.create_pickup_wave_v1(jsonb)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.create_pickup_wave_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE api.create_pickup_wave_v1(jsonb)'
);

SELECT has_function(
  'api',
  'assign_pickup_wave_v1',
  ARRAY['jsonb'],
  'api.assign_pickup_wave_v1 exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.assign_pickup_wave_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE api.assign_pickup_wave_v1(jsonb)'
);
SELECT ok(
  has_function_privilege('service_role', 'api.assign_pickup_wave_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE api.assign_pickup_wave_v1(jsonb)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.assign_pickup_wave_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE api.assign_pickup_wave_v1(jsonb)'
);

SELECT has_function(
  'api',
  'pickup_requests_list_v1',
  ARRAY['uuid', 'uuid', 'text', 'integer'],
  'api.pickup_requests_list_v1 exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.pickup_requests_list_v1(uuid, uuid, text, integer)', 'EXECUTE'),
  'authenticated can EXECUTE api.pickup_requests_list_v1(uuid, uuid, text, integer)'
);
SELECT ok(
  has_function_privilege('service_role', 'api.pickup_requests_list_v1(uuid, uuid, text, integer)', 'EXECUTE'),
  'service_role can EXECUTE api.pickup_requests_list_v1(uuid, uuid, text, integer)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.pickup_requests_list_v1(uuid, uuid, text, integer)', 'EXECUTE'),
  'anon cannot EXECUTE api.pickup_requests_list_v1(uuid, uuid, text, integer)'
);

SELECT has_function(
  'api',
  'pickup_waves_list_v1',
  ARRAY['uuid[]', 'text', 'integer'],
  'api.pickup_waves_list_v1 exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.pickup_waves_list_v1(uuid[], text, integer)', 'EXECUTE'),
  'authenticated can EXECUTE api.pickup_waves_list_v1(uuid[], text, integer)'
);
SELECT ok(
  has_function_privilege('service_role', 'api.pickup_waves_list_v1(uuid[], text, integer)', 'EXECUTE'),
  'service_role can EXECUTE api.pickup_waves_list_v1(uuid[], text, integer)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.pickup_waves_list_v1(uuid[], text, integer)', 'EXECUTE'),
  'anon cannot EXECUTE api.pickup_waves_list_v1(uuid[], text, integer)'
);

SELECT has_function(
  'api',
  'pickup_failures_list_v1',
  ARRAY['uuid[]', 'uuid', 'uuid', 'text', 'integer'],
  'api.pickup_failures_list_v1 exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.pickup_failures_list_v1(uuid[], uuid, uuid, text, integer)', 'EXECUTE'),
  'authenticated can EXECUTE api.pickup_failures_list_v1(uuid[], uuid, uuid, text, integer)'
);
SELECT ok(
  has_function_privilege('service_role', 'api.pickup_failures_list_v1(uuid[], uuid, uuid, text, integer)', 'EXECUTE'),
  'service_role can EXECUTE api.pickup_failures_list_v1(uuid[], uuid, uuid, text, integer)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.pickup_failures_list_v1(uuid[], uuid, uuid, text, integer)', 'EXECUTE'),
  'anon cannot EXECUTE api.pickup_failures_list_v1(uuid[], uuid, uuid, text, integer)'
);

SELECT ok(
  public.resolve_settings_merged('ui_navigation', 'global', NULL::uuid) #> '{apps,console,sections}' @> jsonb_build_array(
    jsonb_build_object(
      'id', 'operations',
      'items', jsonb_build_array(
        jsonb_build_object('id', 'console-pickup-requests', 'href', '/console/operations/pickups/requests'),
        jsonb_build_object('id', 'console-pickup-waves', 'href', '/console/operations/pickups/waves'),
        jsonb_build_object('id', 'console-pickup-failures', 'href', '/console/operations/pickups/failures')
      )
    )
  ),
  'console navigation includes pickup routes'
);

SELECT ok(
  public.resolve_settings_merged('ui_navigation', 'global', NULL::uuid) #> '{apps,portal,sections}' @> jsonb_build_array(
    jsonb_build_object(
      'id', 'operations',
      'items', jsonb_build_array(
        jsonb_build_object('id', 'portal-pickup-requests', 'href', '/portal/operations/pickups/requests'),
        jsonb_build_object('id', 'portal-pickup-waves', 'href', '/portal/operations/pickups/waves'),
        jsonb_build_object('id', 'portal-pickup-failures', 'href', '/portal/operations/pickups/failures')
      )
    )
  ),
  'portal navigation includes pickup routes'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND COALESCE(cached_value#>'{apps,console,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT (
        cached_value#>'{apps,console,sections}' @> jsonb_build_array(
          jsonb_build_object(
            'id', 'operations',
            'items', jsonb_build_array(
              jsonb_build_object('id', 'console-pickup-requests', 'href', '/console/operations/pickups/requests'),
              jsonb_build_object('id', 'console-pickup-waves', 'href', '/console/operations/pickups/waves'),
              jsonb_build_object('id', 'console-pickup-failures', 'href', '/console/operations/pickups/failures')
            )
          )
        )
      )
  ),
  'all scoped console ui_navigation rows include pickup routes'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND COALESCE(cached_value#>'{apps,portal,sections}', '[]'::jsonb) <> '[]'::jsonb
      AND NOT (
        cached_value#>'{apps,portal,sections}' @> jsonb_build_array(
          jsonb_build_object(
            'id', 'operations',
            'items', jsonb_build_array(
              jsonb_build_object('id', 'portal-pickup-requests', 'href', '/portal/operations/pickups/requests'),
              jsonb_build_object('id', 'portal-pickup-waves', 'href', '/portal/operations/pickups/waves'),
              jsonb_build_object('id', 'portal-pickup-failures', 'href', '/portal/operations/pickups/failures')
            )
          )
        )
      )
  ),
  'all scoped portal ui_navigation rows include pickup routes'
);

SELECT * FROM finish();

ROLLBACK;
