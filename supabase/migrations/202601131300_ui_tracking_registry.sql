-- Migration: UI tracking registry (portal tracking config)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601131300_ui_tracking_registry'));
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
VALUES (
  'ui_tracking_registry',
  'UI tracking registry (resource + filter configuration)',
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
-- 2) Schema registry
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
  'ui_tracking_registry',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'properties', jsonb_build_object(
      'resource_key', jsonb_build_object('type', 'string'),
      'filter_key', jsonb_build_object('type', 'string'),
      'param_key', jsonb_build_object('type', 'string'),
      'title', jsonb_build_object('type', 'string'),
      'description', jsonb_build_object('type', 'string'),
      'results_description', jsonb_build_object('type', 'string'),
      'empty', jsonb_build_object('type', 'string'),
      'form', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'label', jsonb_build_object('type', 'string'),
          'placeholder', jsonb_build_object('type', 'string'),
          'search_label', jsonb_build_object('type', 'string'),
          'clear_label', jsonb_build_object('type', 'string')
        )
      )
    ),
    'required', jsonb_build_array('resource_key', 'param_key')
  ),
  'UI tracking registry (v1)',
  '[{"resource_key":"shipments","filter_key":"tracking_number","param_key":"tracking_number","title":"Tracking","description":"Search shipments by tracking number.","results_description":"Tracking results filtered by tracking_number.","empty":"Enter a tracking number to load shipment results.","form":{"label":"Tracking number","placeholder":"Scan or enter tracking number","search_label":"Search","clear_label":"Clear"}}]'::jsonb,
  true
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 3) Seed global defaults
-- ---------------------------------------------------------------------------
WITH defaults AS (
  SELECT jsonb_build_object(
    'resource_key', 'shipments',
    'filter_key', 'tracking_number',
    'param_key', 'tracking_number',
    'title', 'Tracking',
    'description', 'Search shipments by tracking number.',
    'results_description', 'Tracking results filtered by tracking_number.',
    'empty', 'Enter a tracking number to load shipment results.',
    'form', jsonb_build_object(
      'label', 'Tracking number',
      'placeholder', 'Scan or enter tracking number',
      'search_label', 'Search',
      'clear_label', 'Clear'
    )
  ) AS body
),
inserted AS (
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
    'ui_tracking_registry',
    'global',
    NULL::uuid,
    1,
    defaults.body,
    1,
    'seed ui_tracking_registry defaults',
    now()
  FROM defaults
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = 'ui_tracking_registry'
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
  'ui_tracking_registry',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s
  WHERE s.category = 'ui_tracking_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

-- ---------------------------------------------------------------------------
-- 4) UI RPC: ui_tracking_registry_v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ui_tracking_registry_v1()
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
  RETURN public.resolve_settings_merged('ui_tracking_registry', v_scope_type, v_scope_id);
END;
$$;

REVOKE ALL ON FUNCTION public.ui_tracking_registry_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_tracking_registry_v1() TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601131300_ui_tracking_registry'));
COMMIT;
