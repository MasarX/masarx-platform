-- Plan: PLAN-202602-fieldops-mobile-store-ga-v2 / Step: S04
-- Migration: Mobile push policy + resolver v1
-- Date: 2026-02-05
--
-- Goal:
--   - Keep mobile push registration behavior fully row-driven via settings ladder.
--   - Provide a category-specific resolver helper for mobile clients.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602051130_mobile_push_policy_resolver_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category (ladder-resolved; resource scope enabled)
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
VALUES (
  'mobile_push_policy',
  'Mobile Field Ops push registration policy (provider, permission, startup registration behavior) resolved via ladder; branch-aware via resource scope.',
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
-- 2) Schema registry (v1 contract)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'mobile_push_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Mobile Push Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'register_on_startup', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
      'request_permission', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
      'emit_log_events', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
      'provider', jsonb_build_object('type', 'string'),
      'default_channel_id', jsonb_build_object('type', 'string'),
      'default_channel_name', jsonb_build_object('type', 'string')
    )
  ),
  'Field Ops mobile push policy controlling provider and startup registration behavior. Row-driven; resolved via ladder.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', FALSE,
      'register_on_startup', TRUE,
      'request_permission', TRUE,
      'emit_log_events', TRUE,
      'provider', 'expo',
      'default_channel_id', 'fieldops-default',
      'default_channel_name', 'Fieldops Alerts'
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
-- 3) Safe global default (settings_versions + settings cache)
-------------------------------------------------------------------------------

WITH push_defaults AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'register_on_startup', TRUE,
    'request_permission', TRUE,
    'emit_log_events', TRUE,
    'provider', 'expo',
    'default_channel_id', 'fieldops-default',
    'default_channel_name', 'Fieldops Alerts'
  ) AS body
),
inserted_defaults AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'mobile_push_policy', 'global', NULL, 1, push_defaults.body, 1, now() FROM push_defaults
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM inserted_defaults sv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = sv.category
    AND s.scope_type = sv.scope_type
    AND s.scope_id IS NULL
);

-------------------------------------------------------------------------------
-- 4) Category-specific resolver helper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_mobile_push_policy(p_context JSONB)
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
  FROM public.resolve_settings_row_from_policy_context_v1('mobile_push_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_mobile_push_policy(JSONB)
  IS 'Resolve mobile_push_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
ALTER FUNCTION public.resolve_mobile_push_policy(JSONB) SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.resolve_mobile_push_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_push_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_push_policy(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602051130_mobile_push_policy_resolver_v1'));
COMMIT;
