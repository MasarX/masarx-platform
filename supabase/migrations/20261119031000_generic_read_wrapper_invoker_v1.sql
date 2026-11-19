BEGIN;
SET LOCAL lock_timeout = '10s';

-- Each public RPC already runs under the scoped executor and owns its authorization.
ALTER FUNCTION api.ui_get_resource_v1(text, uuid) SECURITY INVOKER;
ALTER FUNCTION api.ui_list_resource_v1(text, jsonb, integer, integer, jsonb) SECURITY INVOKER;
ALTER FUNCTION api.ui_resource_metrics_v1(text, jsonb, text[]) SECURITY INVOKER;
ALTER FUNCTION api.ui_filter_distinct_values_v1(text, text, text, integer) SECURITY INVOKER;

COMMIT;
