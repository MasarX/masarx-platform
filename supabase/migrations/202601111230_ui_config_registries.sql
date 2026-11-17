-- Migration: UI config registries + command route targets
BEGIN;
SELECT pg_advisory_lock(hashtext('202601111230_ui_config_registries'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Settings categories
-- ---------------------------------------------------------------------------
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  request_capability
)
VALUES
  (
    'ui_dashboard_config',
    'UI dashboard layout limits and defaults',
    true,
    true,
    false,
    'hard_fail',
    '["global","tenant","client","sender"]'::jsonb,
    'settings.request'
  ),
  (
    'ui_filter_operators',
    'UI filter operator definitions and labels',
    true,
    true,
    false,
    'hard_fail',
    '["global","tenant","client","sender"]'::jsonb,
    'settings.request'
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    request_capability = EXCLUDED.request_capability,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 2) Schema registry (dashboard, filter operators, command routes)
-- ---------------------------------------------------------------------------
WITH dashboard_schema AS (
  SELECT
    'ui_dashboard_config'::text AS category,
    1 AS version,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'properties', jsonb_build_object(
        'max_sections', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 20),
        'max_items_per_section', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 50),
        'max_actions', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 20),
        'max_metrics', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 50)
      ),
      'required', jsonb_build_array('max_sections','max_items_per_section','max_actions','max_metrics')
    ) AS schema,
    'UI dashboard config (v1)'::text AS description,
    '[{"max_sections":4,"max_items_per_section":6,"max_actions":4,"max_metrics":6}]'::jsonb AS examples
),
filter_ops_schema AS (
  SELECT
    'ui_filter_operators'::text AS category,
    1 AS version,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'properties', jsonb_build_object(
        'operators', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object(
            'type', 'object',
            'properties', jsonb_build_object(
              'key', jsonb_build_object('type', 'string'),
              'label', jsonb_build_object('type', 'string'),
              'supports_array', jsonb_build_object('type', 'boolean')
            ),
            'required', jsonb_build_array('key','label')
          )
        )
      ),
      'required', jsonb_build_array('operators')
    ) AS schema,
    'UI filter operators (v1)'::text AS description,
    '[{"operators":[{"key":"eq","label":"equals","supports_array":true},{"key":"ne","label":"not equal","supports_array":true},{"key":"gt","label":">"},{"key":"gte","label":">="},{"key":"lt","label":"<"},{"key":"lte","label":"<="},{"key":"ilike","label":"contains","supports_array":true}]}]'::jsonb AS examples
),
command_schema AS (
  SELECT
    'ui_command_registry'::text AS category,
    1 AS version,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'properties', jsonb_build_object(
        'commands', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object(
            'type', 'object',
            'properties', jsonb_build_object(
              'key', jsonb_build_object('type', 'string'),
              'label', jsonb_build_object('type', 'string'),
              'description', jsonb_build_object('type', 'string'),
              'capability', jsonb_build_object('type', 'string'),
              'schema_category', jsonb_build_object('type', 'string'),
              'workflow_key', jsonb_build_object('type', 'string'),
              'route_targets', jsonb_build_object(
                'type', 'object',
                'additionalProperties', jsonb_build_object(
                  'type', 'object',
                  'properties', jsonb_build_object(
                    'path', jsonb_build_object('type', 'string'),
                    'params', jsonb_build_object('type', 'object')
                  ),
                  'required', jsonb_build_array('path')
                )
              )
            ),
            'required', jsonb_build_array('key','label','capability')
          )
        )
      ),
      'required', jsonb_build_array('commands')
    ) AS schema,
    'UI command registry (v1)'::text AS description,
    NULL::jsonb AS examples
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT category, version, schema, description, examples, true FROM dashboard_schema
UNION ALL
SELECT category, version, schema, description, examples, true FROM filter_ops_schema
UNION ALL
SELECT category, version, schema, description, examples, true FROM command_schema
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 3) Seed global defaults
-- ---------------------------------------------------------------------------
WITH dashboard_defaults AS (
  SELECT jsonb_build_object(
    'max_sections', 4,
    'max_items_per_section', 6,
    'max_actions', 4,
    'max_metrics', 6
  ) AS body
),
dashboard_inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at
  )
  SELECT
    'ui_dashboard_config',
    'global',
    NULL::uuid,
    1,
    dashboard_defaults.body,
    1,
    'seed ui_dashboard_config defaults',
    now()
  FROM dashboard_defaults
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = 'ui_dashboard_config'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'ui_dashboard_config',
  'global',
  NULL::uuid,
  dashboard_inserted.id,
  dashboard_inserted.value,
  now()
FROM dashboard_inserted
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s
  WHERE s.category = 'ui_dashboard_config'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

WITH filter_defaults AS (
  SELECT jsonb_build_object(
    'operators', jsonb_build_array(
      jsonb_build_object('key','eq','label','equals','supports_array', true),
      jsonb_build_object('key','ne','label','not equal','supports_array', true),
      jsonb_build_object('key','gt','label','>'),
      jsonb_build_object('key','gte','label','>='),
      jsonb_build_object('key','lt','label','<'),
      jsonb_build_object('key','lte','label','<='),
      jsonb_build_object('key','ilike','label','contains','supports_array', true)
    )
  ) AS body
),
filter_inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at
  )
  SELECT
    'ui_filter_operators',
    'global',
    NULL::uuid,
    1,
    filter_defaults.body,
    1,
    'seed ui_filter_operators defaults',
    now()
  FROM filter_defaults
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = 'ui_filter_operators'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'ui_filter_operators',
  'global',
  NULL::uuid,
  filter_inserted.id,
  filter_inserted.value,
  now()
FROM filter_inserted
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s
  WHERE s.category = 'ui_filter_operators'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

-- ---------------------------------------------------------------------------
-- 4) Seed route targets for command registry defaults
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB;
  v_updated JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
  v_updated := (
    SELECT jsonb_agg(
      CASE
        WHEN item->>'key' = 'settings_change_request' THEN
          CASE
            WHEN item ? 'route_targets' THEN item
            ELSE jsonb_set(
              item,
              '{route_targets}',
              jsonb_build_object(
                'console', jsonb_build_object('path', '/settings/request'),
                'portal', jsonb_build_object('path', '/settings/request')
              ),
              true
            )
          END
        WHEN item->>'key' = 'access_policy_change_request' THEN
          CASE
            WHEN item ? 'route_targets' THEN item
            ELSE jsonb_set(
              item,
              '{route_targets}',
              jsonb_build_object(
                'console', jsonb_build_object('path', '/access-policy/request'),
                'portal', jsonb_build_object('path', '/access-policy/request')
              ),
              true
            )
          END
        ELSE item
      END
    )
    FROM jsonb_array_elements(v_commands) AS item
  );

  v_current := jsonb_set(v_current, '{commands}', COALESCE(v_updated, v_commands), true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Seed ui_command_registry route targets',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

-- ---------------------------------------------------------------------------
-- 5) UI read RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ui_dashboard_config_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
BEGIN
  RETURN public.resolve_settings_merged('ui_dashboard_config', v_scope_type, v_scope_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_filter_operators_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
BEGIN
  RETURN public.resolve_settings_merged('ui_filter_operators', v_scope_type, v_scope_id);
END;
$$;

REVOKE ALL ON FUNCTION public.ui_dashboard_config_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_filter_operators_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_dashboard_config_v1() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_filter_operators_v1() TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601111230_ui_config_registries'));
COMMIT;
