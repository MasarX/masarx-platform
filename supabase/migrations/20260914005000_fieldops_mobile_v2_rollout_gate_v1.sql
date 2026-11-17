BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260914005000_fieldops_mobile_v2_rollout_gate_v1'));

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default, side_effecting,
  safe_missing_behavior, allowed_scopes, resource_scope_rel
)
VALUES (
  'mobile_shell_policy',
  'FieldOps mobile shell rollout policy resolved through the canonical settings ladder.',
  TRUE, TRUE, FALSE, 'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    resource_scope_rel = EXCLUDED.resource_scope_rel,
    updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'mobile_shell_policy', 1,
  '{
    "$schema":"http://json-schema.org/draft-07/schema#",
    "title":"Mobile Shell Policy",
    "type":"object",
    "additionalProperties":false,
    "required":["version","v2_enabled"],
    "properties":{
      "version":{"type":"integer","minimum":1},
      "v2_enabled":{"type":"boolean"}
    }
  }'::jsonb,
  'FieldOps mobile shell rollout gate.',
  '[{"version":1,"v2_enabled":false},{"version":1,"v2_enabled":true}]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active,
    updated_at = now();

INSERT INTO public.settings_versions (
  id, category, scope_type, scope_id, scope_hash, version, value, schema_version,
  change_reason, approved_at, effective_from
)
SELECT
  'f3980000-0000-4000-8000-000000000001'::uuid,
  'mobile_shell_policy', 'global', NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  1, '{"version":1,"v2_enabled":false}'::jsonb, 1,
  'Initial fail-closed FieldOps V2 rollout baseline', now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings_versions
  WHERE category = 'mobile_shell_policy'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND effective_until IS NULL
)
ON CONFLICT (id, scope_hash) DO NOTHING;

INSERT INTO public.settings (
  id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
)
SELECT
  'f3980000-0000-4000-8000-000000000002'::uuid,
  sv.category, sv.scope_type, sv.scope_id, sv.scope_hash, sv.id, sv.value, now()
FROM public.settings_versions sv
WHERE sv.category = 'mobile_shell_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL
ORDER BY sv.version DESC
LIMIT 1
ON CONFLICT (category, scope_type, scope_hash) DO NOTHING;

CREATE OR REPLACE FUNCTION public.resolve_mobile_shell_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('mobile_shell_policy', p_context)
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.resolve_mobile_shell_policy(JSONB)
  IS 'Resolve mobile_shell_policy through the canonical settings policy context ladder.';
REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_shell_policy(JSONB) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.resolve_mobile_shell_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.resolve_mobile_shell_policy(p_context);
$function$;

REVOKE ALL ON FUNCTION api.resolve_mobile_shell_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_mobile_shell_policy(JSONB) FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_mobile_shell_policy(JSONB) TO authenticated, service_role;

COMMIT;
