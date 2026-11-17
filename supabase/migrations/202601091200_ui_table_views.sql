-- Migration: UI table views registry + RPC
BEGIN;
SELECT pg_advisory_lock(hashtext('202601091200_ui_table_views'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Settings category registry
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
    'ui_table_views',
    'UI table view presets (columns, filters, sorting, grouping)',
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
-- 2) Schema registry for ui_table_views
-- ---------------------------------------------------------------------------
INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'ui_table_views',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'properties', jsonb_build_object(
      'resources', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'default_view_id', jsonb_build_object('type', 'string'),
            'views', jsonb_build_object(
              'type', 'object',
              'additionalProperties', jsonb_build_object(
                'type', 'object',
                'properties', jsonb_build_object(
                  'label', jsonb_build_object('type', 'string'),
                  'description', jsonb_build_object('type', 'string'),
                  'columns', jsonb_build_object(
                    'type', 'object',
                    'properties', jsonb_build_object(
                      'order', jsonb_build_object(
                        'type', 'array',
                        'items', jsonb_build_object('type', 'string')
                      ),
                      'hidden', jsonb_build_object(
                        'type', 'array',
                        'items', jsonb_build_object('type', 'string')
                      )
                    )
                  ),
                  'filters', jsonb_build_object(
                    'type', 'object',
                    'additionalProperties', jsonb_build_object('type', 'string')
                  ),
                  'sort', jsonb_build_object(
                    'type', 'object',
                    'properties', jsonb_build_object(
                      'key', jsonb_build_object('type', 'string'),
                      'direction', jsonb_build_object(
                        'type', 'string',
                        'enum', jsonb_build_array('asc', 'desc')
                      )
                    )
                  ),
                  'group_by', jsonb_build_object('type', 'string'),
                  'page_size', jsonb_build_object('type', 'integer', 'minimum', 1)
                ),
                'required', jsonb_build_array('label')
              )
            )
          )
        )
      )
    )
  ),
  'UI table view presets keyed by resource',
  '[{"resources":{"shipments":{"default_view_id":"all","views":{"all":{"label":"All shipments","sort":{"key":"created_at","direction":"desc"}}}}}}]'::jsonb,
  true
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 3) Global defaults
-- ---------------------------------------------------------------------------
WITH defaults AS (
  SELECT jsonb_build_object('resources', jsonb_build_object()) AS body
)
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
  'ui_table_views',
  'global',
  NULL::uuid,
  1,
  defaults.body,
  1,
  'seed ui_table_views defaults',
  now()
FROM defaults
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings_versions sv
  WHERE sv.category = 'ui_table_views'
    AND sv.scope_type = 'global'
    AND sv.scope_id IS NULL
);

-- ---------------------------------------------------------------------------
-- 4) UI RPC: ui_table_views_v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ui_table_views_v1(
  p_resource TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), public.current_user_scope_type(), 'global'));
  v_scope_id UUID := COALESCE(p_scope_id, public.current_user_scope_id());
  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_value JSONB;
  v_version INT;
  v_scope_path JSONB;
  v_resolution_id UUID;
  v_resolved JSONB := '{}'::jsonb;
  v_resource JSONB := '{}'::jsonb;
  v_scope_value JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_table_views_v1 requires authenticated user';
  END IF;

  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_table_views_v1 requires resource key';
  END IF;

  SELECT scope_type, scope_id, organization_id, client_id, sender_id
    INTO v_scope_type, v_scope_id, v_org_id, v_client_id, v_sender_id
    FROM public.resolve_settings_scope_context_v1(v_scope_type, v_scope_id)
    LIMIT 1;

  PERFORM public.assert_capability_v1('settings.read', v_scope_type, v_scope_id);

  v_resolved := COALESCE(
    public.resolve_settings_merged('ui_table_views', v_scope_type, v_scope_id),
    '{}'::jsonb
  );
  v_resource := COALESCE(v_resolved->'resources'->p_resource, '{}'::jsonb);

  SELECT settings_id, settings_version_id, scope_type, scope_id, value, version, scope_path
    INTO v_settings_id, v_settings_version_id, v_scope_type, v_scope_id, v_value, v_version, v_scope_path
    FROM public.resolve_settings_row('ui_table_views', v_scope_type, v_scope_id)
    LIMIT 1;

  v_resolution_id := public.log_settings_resolution(
    p_organization_id := v_org_id,
    p_category := 'ui_table_views',
    p_winning_scope_type := v_scope_type,
    p_winning_scope_id := v_scope_id,
    p_winning_settings_id := v_settings_id,
    p_winning_settings_version_id := v_settings_version_id,
    p_winning_version := v_version,
    p_scope_path := v_scope_path,
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id
    )),
    p_merge_notes := NULL
  );

  SELECT cached_value
    INTO v_scope_value
    FROM public.settings
    WHERE category = 'ui_table_views'
      AND scope_type = v_scope_type
      AND scope_id IS NOT DISTINCT FROM v_scope_id
    ORDER BY last_updated DESC
    LIMIT 1;

  RETURN jsonb_build_object(
    'resource', p_resource,
    'views', COALESCE(v_resource->'views', '{}'::jsonb),
    'default_view_id', v_resource->>'default_view_id',
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'settings_resolution_id', v_resolution_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'scope_path', v_scope_path,
    'scope_value', v_scope_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_table_views_v1(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_table_views_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601091200_ui_table_views'));
COMMIT;
