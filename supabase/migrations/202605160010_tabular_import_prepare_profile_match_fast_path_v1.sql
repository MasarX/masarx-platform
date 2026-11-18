-- Console V2 import prepare can hit the shared RPC timeout before a
-- tabular_import_runs row is created when the browser-backed edge path checks
-- reusable mapping profiles by listing every tabular-import profile. Keep the
-- fail-fast unmapped-header behavior, but make the profile check a direct,
-- indexed lookup by tenant/resource/header fingerprint.

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_mapping_configs_tabular_import_profile_match
  ON public.mapping_configs (
    organization_id,
    (mapping_config->>'resource_key'),
    (mapping_config->>'header_fingerprint'),
    updated_at DESC,
    created_at DESC
  )
  WHERE mapping_type = 'tabular_import';

CREATE OR REPLACE FUNCTION public.ui_match_tabular_import_profile_v1(
  p_resource TEXT,
  p_scope_context JSONB,
  p_header_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_resource_key TEXT := NULLIF(btrim(COALESCE(p_resource, '')), '');
  v_header_fingerprint TEXT := NULLIF(btrim(COALESCE(p_header_fingerprint, '')), '');
  v_scope_resolution JSONB := public.ui_resolve_import_scope_context_v1(
    jsonb_build_object(
      'resource_key', NULLIF(btrim(COALESCE(p_resource, '')), ''),
      'scope_context', COALESCE(p_scope_context, '{}'::jsonb)
    )
  );
  v_org_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>'organization_id');
  v_resource JSONB;
  v_capability TEXT;
  v_profile JSONB;
BEGIN
  IF v_resource_key IS NULL THEN
    RAISE EXCEPTION 'ui_match_tabular_import_profile_v1 requires resource key';
  END IF;
  IF v_header_fingerprint IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_match_tabular_import_profile_v1 requires organization scope';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);
  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_match_tabular_import_profile_v1 unknown resource %', v_resource_key;
  END IF;
  IF COALESCE((v_resource#>>ARRAY['import','enabled'])::boolean, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_match_tabular_import_profile_v1 import disabled for resource %', v_resource_key;
  END IF;

  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), '')
  );
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, 'tenant', v_org_id);
  END IF;

  SELECT jsonb_build_object(
    'id', mc.id,
    'profile_name', NULLIF(btrim(COALESCE(mc.mapping_config->>'profile_name', '')), ''),
    'profile_slug', public.tabular_import_slug_v1(
      COALESCE(
        NULLIF(btrim(COALESCE(mc.mapping_config->>'profile_name', '')), ''),
        split_part(mc.mapping_key, '::', 3)
      )
    ),
    'header_fingerprint', NULLIF(btrim(COALESCE(mc.mapping_config->>'header_fingerprint', '')), ''),
    'sheet_hint', NULLIF(btrim(COALESCE(mc.mapping_config->>'sheet_hint', '')), ''),
    'write_mode', COALESCE(NULLIF(btrim(COALESCE(mc.mapping_config->>'write_mode', '')), ''), 'create'),
    'mapping_key', mc.mapping_key,
    'mapping_config', mc.mapping_config,
    'created_at', mc.created_at,
    'updated_at', mc.updated_at
  )
    INTO v_profile
    FROM public.mapping_configs mc
   WHERE mc.organization_id = v_org_id
     AND mc.mapping_type = 'tabular_import'
     AND COALESCE(mc.mapping_config->>'resource_key', '') = v_resource_key
     AND COALESCE(mc.mapping_config->>'header_fingerprint', '') = v_header_fingerprint
     AND jsonb_typeof(mc.mapping_config->'field_rules') = 'array'
     AND jsonb_array_length(mc.mapping_config->'field_rules') > 0
   ORDER BY mc.updated_at DESC, mc.created_at DESC
   LIMIT 1;

  RETURN v_profile;
END;
$function$;

COMMENT ON FUNCTION public.ui_match_tabular_import_profile_v1(TEXT, JSONB, TEXT) IS
  'Returns the newest scoped tabular import profile matching a resource/header fingerprint without listing every profile.';

CREATE OR REPLACE FUNCTION api.ui_match_tabular_import_profile_v1(
  p_resource TEXT,
  p_scope_context JSONB,
  p_header_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_match_tabular_import_profile_v1($1, $2, $3);
$function$;

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := E'    SELECT value\n      INTO v_profile_match\n      FROM (\n        SELECT jsonb_build_object(\n          ''id'', profile.id,\n          ''profile_name'', profile.profile_name,\n          ''profile_slug'', profile.profile_slug,\n          ''header_fingerprint'', profile.header_fingerprint,\n          ''sheet_hint'', profile.sheet_hint,\n          ''write_mode'', profile.write_mode,\n          ''mapping_key'', profile.mapping_key,\n          ''mapping_config'', profile.mapping_config,\n          ''created_at'', profile.created_at,\n          ''updated_at'', profile.updated_at\n        ) AS value\n        FROM public.ui_tabular_import_profiles_v1(\n          v_resource_key,\n          COALESCE(v_scope_resolution->''scope_context'', ''{}''::jsonb)\n        ) AS profile\n      ) profiles\n     WHERE COALESCE(value->>''header_fingerprint'', '''') = COALESCE(v_header_fingerprint, '''')\n     ORDER BY COALESCE(value->>''updated_at'', value->>''created_at'', '''') DESC\n     LIMIT 1;';
  v_new TEXT := E'    -- tabular_import_prepare_v1.profile_match_fast_path_v1: avoid listing every profile before the run row exists.\n    SELECT public.ui_match_tabular_import_profile_v1(\n      v_resource_key,\n      COALESCE(v_scope_resolution->''scope_context'', ''{}''::jsonb),\n      v_header_fingerprint\n    )\n      INTO v_profile_match;';
BEGIN
  SELECT pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.tabular_import_prepare_v1(jsonb) is missing';
  END IF;

  IF position('tabular_import_prepare_v1.profile_match_fast_path_v1' IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'Could not locate profile listing block in public.tabular_import_prepare_v1';
  END IF;

  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END;
$do$;

ALTER FUNCTION public.tabular_import_prepare_v1(JSONB)
  SET statement_timeout = '30s';

COMMENT ON FUNCTION public.tabular_import_prepare_v1(JSONB) IS
  'Prepares a row-driven tabular import run, uses indexed profile matching before staging, reuses the loaded registry, and has a bounded 30s function-level statement timeout for browser-backed import preparation.';

REVOKE ALL ON FUNCTION public.ui_match_tabular_import_profile_v1(TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_match_tabular_import_profile_v1(TEXT, JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_match_tabular_import_profile_v1(TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_match_tabular_import_profile_v1(TEXT, JSONB, TEXT) TO authenticated, service_role;

COMMIT;
