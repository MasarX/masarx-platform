-- Migration: expose a whitelisted public tracking configuration facade.
BEGIN;
SELECT pg_advisory_lock(hashtext('202609010900_b5_public_tracking_config_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.public_tracking_config_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
  WITH source AS (
    SELECT s.cached_value AS value
      FROM public.settings s
     WHERE s.category = 'ui_tracking_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'resource_key', source.value->>'resource_key',
    'filter_key', source.value->>'filter_key',
    'param_key', source.value->>'param_key',
    'title', source.value->>'title',
    'description', source.value->>'description',
    'results_description', source.value->>'results_description',
    'empty', source.value->>'empty',
    'form', jsonb_strip_nulls(jsonb_build_object(
      'label', source.value#>>'{form,label}',
      'placeholder', source.value#>>'{form,placeholder}',
      'search_label', source.value#>>'{form,search_label}',
      'clear_label', source.value#>>'{form,clear_label}'
    ))
  ))
    FROM source;
$function$;

REVOKE ALL ON FUNCTION public.public_tracking_config_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_tracking_config_v1() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION api.public_tracking_config_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.public_tracking_config_v1();
$function$;

REVOKE ALL ON FUNCTION api.public_tracking_config_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.public_tracking_config_v1() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.public_tracking_config_v1() IS
  'Public-safe global tracking UI configuration facade. Returns only explicitly whitelisted presentation and lookup keys.';
COMMENT ON FUNCTION api.public_tracking_config_v1() IS
  'Browser-safe api wrapper for the whitelisted public tracking UI configuration.';

SELECT pg_advisory_unlock(hashtext('202609010900_b5_public_tracking_config_v1'));
COMMIT;
