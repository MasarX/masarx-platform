-- Plan: PLAN-202602-fieldops-mobile-app-prod-completion / Step: S02
-- Migration: Mobile shell policy pack v1
-- Date: 2026-02-06
--
-- Purpose:
-- - Add row-driven policy categories needed for Field Ops sample-parity shell behavior.
-- - Keep all policy resolution ladder-compliant via category-specific resolver wrappers.
-- - Seed safe global defaults with no tenant/client hardcoding.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602061540_mobile_shell_policy_pack_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Category registry
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES
  (
    'device_policy',
    'Mobile device policy (allowed/default platforms) resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'navigation_policy',
    'Mobile navigation policy (provider mapping by platform) resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'map_policy',
    'Mobile route/list map policy (views and clustering) resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'communication_policy',
    'Mobile communication channel/template policy resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'address_policy',
    'Mobile address rendering policy resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'driver_safety_policy',
    'Mobile driver safety lock policy resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'ux_safety_policy',
    'Mobile UX safety guard policy (double-tap confirmations) resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Schema registry
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'device_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Device Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'allowed_platforms', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string'),
          'uniqueItems', TRUE
        ),
        'default_platform', jsonb_build_object('type', jsonb_build_array('string', 'null'))
      )
    ),
    'Field Ops device policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'allowed_platforms', jsonb_build_array('android', 'ios', 'scanner'),
        'default_platform', 'android'
      )
    ),
    TRUE
  ),
  (
    'navigation_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Navigation Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'provider_by_platform', jsonb_build_object('type', jsonb_build_array('object', 'null'))
      )
    ),
    'Field Ops platform navigation provider policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'provider_by_platform',
        jsonb_build_object('ios', 'apple', 'android', 'google', 'scanner', 'google')
      )
    ),
    TRUE
  ),
  (
    'map_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Map Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'route_views', jsonb_build_object(
          'type', jsonb_build_array('array', 'null'),
          'items', jsonb_build_object('type', 'string'),
          'uniqueItems', TRUE
        ),
        'default_route_view_by_layout', jsonb_build_object('type', jsonb_build_array('object', 'null')),
        'clustering', jsonb_build_object('type', jsonb_build_array('object', 'null')),
        'show_legend', jsonb_build_object('type', jsonb_build_array('boolean', 'null'))
      )
    ),
    'Field Ops route/list map policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'route_views', jsonb_build_array('list', 'orders_map'),
        'default_route_view_by_layout', jsonb_build_object('mobile', 'list'),
        'clustering', jsonb_build_object('enabled', TRUE, 'grid_px', 120, 'min_count', 2),
        'show_legend', TRUE
      )
    ),
    TRUE
  ),
  (
    'communication_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Communication Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'allowed_channels', jsonb_build_object(
          'type', jsonb_build_array('array', 'null'),
          'items', jsonb_build_object('type', 'string'),
          'uniqueItems', TRUE
        ),
        'templates', jsonb_build_object('type', jsonb_build_array('array', 'null'))
      )
    ),
    'Field Ops communication channels/templates policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'allowed_channels', jsonb_build_array('call', 'sms', 'whatsapp'),
        'templates', jsonb_build_array()
      )
    ),
    TRUE
  ),
  (
    'address_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Address Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'fields', jsonb_build_object('type', jsonb_build_array('array', 'null')),
        'show_coordinates', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
        'show_accuracy', jsonb_build_object('type', jsonb_build_array('boolean', 'null'))
      )
    ),
    'Field Ops address rendering policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'fields', jsonb_build_array(
          jsonb_build_object('key', 'address', 'label', 'Address', 'required', TRUE)
        ),
        'show_coordinates', TRUE,
        'show_accuracy', TRUE
      )
    ),
    TRUE
  ),
  (
    'driver_safety_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Driver Safety Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'driving_mode', jsonb_build_object('type', jsonb_build_array('object', 'null'))
      )
    ),
    'Field Ops driver distraction and interaction safety policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'driving_mode', jsonb_build_object(
          'enabled', FALSE,
          'lock_when_moving', TRUE,
          'lock_threshold_kph', 8,
          'allowed_nav_keys_while_moving', jsonb_build_array('route'),
          'max_single_glance_sec', 2,
          'max_total_glance_sec', 12
        )
      )
    ),
    TRUE
  ),
  (
    'ux_safety_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'UX Safety Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'require_double_tap_for', jsonb_build_object(
          'type', jsonb_build_array('array', 'null'),
          'items', jsonb_build_object('type', 'string'),
          'uniqueItems', TRUE
        )
      )
    ),
    'Field Ops UX safety policy for explicit confirmations.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'require_double_tap_for',
        jsonb_build_array('task_completed', 'task_exception', 'settlement_counted')
      )
    ),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-------------------------------------------------------------------------------
-- 3) Global defaults (settings_versions + settings cache)
-------------------------------------------------------------------------------

WITH defaults AS (
  SELECT * FROM (
    VALUES
      ('device_policy', jsonb_build_object('version', 1, 'allowed_platforms', jsonb_build_array('android', 'ios', 'scanner'), 'default_platform', 'android')),
      ('navigation_policy', jsonb_build_object('version', 1, 'provider_by_platform', jsonb_build_object('ios', 'apple', 'android', 'google', 'scanner', 'google'))),
      ('map_policy', jsonb_build_object('version', 1, 'route_views', jsonb_build_array('list', 'orders_map'), 'default_route_view_by_layout', jsonb_build_object('mobile', 'list'), 'clustering', jsonb_build_object('enabled', TRUE, 'grid_px', 120, 'min_count', 2), 'show_legend', TRUE)),
      ('communication_policy', jsonb_build_object('version', 1, 'allowed_channels', jsonb_build_array('call', 'sms', 'whatsapp'), 'templates', jsonb_build_array())),
      ('address_policy', jsonb_build_object('version', 1, 'fields', jsonb_build_array(jsonb_build_object('key', 'address', 'label', 'Address', 'required', TRUE)), 'show_coordinates', TRUE, 'show_accuracy', TRUE)),
      ('driver_safety_policy', jsonb_build_object('version', 1, 'driving_mode', jsonb_build_object('enabled', FALSE, 'lock_when_moving', TRUE, 'lock_threshold_kph', 8, 'allowed_nav_keys_while_moving', jsonb_build_array('route'), 'max_single_glance_sec', 2, 'max_total_glance_sec', 12))),
      ('ux_safety_policy', jsonb_build_object('version', 1, 'require_double_tap_for', jsonb_build_array('task_completed', 'task_exception', 'settlement_counted')))
  ) AS t(category, value)
),
inserted_versions AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT d.category, 'global', NULL, 1, d.value, 1, now()
  FROM defaults d
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM inserted_versions sv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = sv.category
    AND s.scope_type = sv.scope_type
    AND s.scope_id IS NULL
);

-------------------------------------------------------------------------------
-- 4) Category-specific resolver wrappers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_device_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('device_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_device_policy(JSONB)
  IS 'Resolve device_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_device_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_device_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_device_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_navigation_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('navigation_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_navigation_policy(JSONB)
  IS 'Resolve navigation_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_navigation_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_navigation_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_navigation_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_map_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('map_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_map_policy(JSONB)
  IS 'Resolve map_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_map_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_map_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_map_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_communication_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('communication_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_communication_policy(JSONB)
  IS 'Resolve communication_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_communication_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_communication_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_communication_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_address_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('address_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_address_policy(JSONB)
  IS 'Resolve address_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_address_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_address_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_address_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_driver_safety_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('driver_safety_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_driver_safety_policy(JSONB)
  IS 'Resolve driver_safety_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_driver_safety_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_driver_safety_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_driver_safety_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_ux_safety_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('ux_safety_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_ux_safety_policy(JSONB)
  IS 'Resolve ux_safety_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_ux_safety_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_ux_safety_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_ux_safety_policy(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602061540_mobile_shell_policy_pack_v1'));
COMMIT;
