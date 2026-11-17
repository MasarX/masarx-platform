-- Plan: PLAN-202602-mobile-field-ops-native-app-v1 / Step: S04
-- Migration: Mobile UI policies v1 (mobile_visibility_policy + mobile_diagnostics_policy)
-- Date: 2026-02-04
--
-- Goals:
--   - Keep Field Ops mobile UI visibility + diagnostics configuration row-driven via the settings ladder.
--   - Provide versioned JSON schemas + safe global defaults (no hardcoding in mobile apps).
--
BEGIN;
SELECT pg_advisory_lock(hashtext('202602041720_mobile_ui_policies_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings categories (ladder-resolved; branch-aware via resource scope)
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
    'mobile_visibility_policy',
    'Mobile Field Ops visibility policy (allowed visibility modes + defaults) resolved via ladder; branch-aware via resource scope.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_diagnostics_policy',
    'Mobile Field Ops diagnostics policy (enable diagnostics + user toggles) resolved via ladder; branch-aware via resource scope.',
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
-- 2) Schema registry (minimal v1 contracts; extend via versioning)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'mobile_visibility_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile Visibility Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'default_visibility', jsonb_build_object(
          'type', jsonb_build_array('string','null')
        ),
        'allowed_visibility', jsonb_build_object(
          'type', jsonb_build_array('array','null'),
          'items', jsonb_build_object('type', 'string'),
          'uniqueItems', TRUE
        ),
        'allow_user_select', jsonb_build_object('type', jsonb_build_array('boolean','null'))
      )
    ),
    'Field Ops mobile visibility policy controlling list visibility modes and defaults. Row-driven; resolved via ladder.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'default_visibility', 'assigned_only',
        'allowed_visibility', jsonb_build_array('assigned_only','branch','zone','organization'),
        'allow_user_select', TRUE
      )
    ),
    TRUE
  ),
  (
    'mobile_diagnostics_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile Diagnostics Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'allow_user_toggle', jsonb_build_object('type', jsonb_build_array('boolean','null')),
        'default_on', jsonb_build_object('type', jsonb_build_array('boolean','null'))
      )
    ),
    'Field Ops mobile diagnostics policy controlling diagnostics visibility and user toggles. Row-driven; resolved via ladder.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', FALSE,
        'allow_user_toggle', FALSE,
        'default_on', FALSE
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
-- 3) Safe global defaults (settings_versions + settings cache)
-------------------------------------------------------------------------------

WITH visibility_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'default_visibility', 'assigned_only',
    'allowed_visibility', jsonb_build_array('assigned_only','branch','zone','organization'),
    'allow_user_select', TRUE
  ) AS body
),
diagnostics_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'allow_user_toggle', FALSE,
    'default_on', FALSE
  ) AS body
),
inserted_visibility AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'mobile_visibility_policy', 'global', NULL, 1, visibility_upsert.body, 1, now() FROM visibility_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
),
inserted_diagnostics AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'mobile_diagnostics_policy', 'global', NULL, 1, diagnostics_upsert.body, 1, now() FROM diagnostics_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM (
  SELECT * FROM inserted_visibility
  UNION ALL SELECT * FROM inserted_diagnostics
) sv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = sv.category
    AND s.scope_type = sv.scope_type
    AND s.scope_id IS NULL
);

SELECT pg_advisory_unlock(hashtext('202602041720_mobile_ui_policies_v1'));
COMMIT;

