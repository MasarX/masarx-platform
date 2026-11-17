SELECT pg_advisory_lock(hashtext('202601091640_ui_pagination_settings'));

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
    'ui_pagination',
    'UI pagination limits and default page sizes',
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

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'ui_pagination',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'properties', jsonb_build_object(
      'max_page_size', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 1000),
      'default_page_size', jsonb_build_object('type', 'integer', 'minimum', 1),
      'allowed_sizes', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object('type', 'integer', 'minimum', 1)
      )
    ),
    'required', jsonb_build_array('max_page_size', 'default_page_size', 'allowed_sizes')
  ),
  'UI pagination defaults and limits',
  '[{"max_page_size":200,"default_page_size":25,"allowed_sizes":[10,25,50,100,200]}]'::jsonb,
  true
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active,
    updated_at = now();

WITH defaults AS (
  SELECT jsonb_build_object(
    'max_page_size', 200,
    'default_page_size', 25,
    'allowed_sizes', jsonb_build_array(10, 25, 50, 100, 200)
  ) AS body
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
  'ui_pagination',
  'global',
  NULL::uuid,
  1,
  defaults.body,
  1,
  'seed ui_pagination defaults',
  now()
FROM defaults
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings_versions sv
  WHERE sv.category = 'ui_pagination'
    AND sv.scope_type = 'global'
    AND sv.scope_id IS NULL
);

SELECT pg_advisory_unlock(hashtext('202601091640_ui_pagination_settings'));
