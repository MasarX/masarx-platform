-- Migration: Plugin Studio egress placeholder diagnostics
--
-- Purpose:
--   - Keep Plugin Studio API plugin authoring row-driven by teaching the
--     integration_plugin_egress_policy default denylist about documentation
--     placeholder hosts.
--   - Prevent sample curl/openapi hosts from being accepted as real provider
--     endpoints during preview/save and later failing only after runtime egress.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202605260230_plugin_studio_egress_placeholder_diagnostics_v1'));

DO $policy$
DECLARE
  v_placeholder_hosts JSONB := jsonb_build_array(
    'example.com',
    '.example.com',
    'example.net',
    '.example.net',
    'example.org',
    '.example.org',
    '.example',
    '.invalid',
    '.test'
  );
  v_schema_example JSONB;
  v_row RECORD;
  v_next_value JSONB;
  v_next_denylist JSONB;
BEGIN
  SELECT COALESCE(examples->0, '{}'::jsonb)
    INTO v_schema_example
    FROM public.schema_registry
   WHERE category = 'integration_plugin_egress_policy'
     AND version = 1
   LIMIT 1;

  SELECT jsonb_agg(DISTINCT host_value ORDER BY host_value)
    INTO v_next_denylist
    FROM (
      SELECT value AS host_value
        FROM jsonb_array_elements_text(COALESCE(v_schema_example->'domain_denylist', '[]'::jsonb))
      UNION ALL
      SELECT value AS host_value
        FROM jsonb_array_elements_text(v_placeholder_hosts)
    ) AS hosts;

  v_schema_example := jsonb_set(
    COALESCE(v_schema_example, '{}'::jsonb),
    '{domain_denylist}',
    v_next_denylist,
    TRUE
  );

  UPDATE public.schema_registry
     SET examples = jsonb_set(
           COALESCE(examples, '[]'::jsonb),
           '{0}',
           v_schema_example,
           TRUE
         ),
         updated_at = now()
   WHERE category = 'integration_plugin_egress_policy'
     AND version = 1;

  FOR v_row IN
    SELECT
      s.category,
      s.scope_type,
      s.scope_id,
      s.cached_value AS value,
      sv.schema_version
      FROM public.settings s
      LEFT JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
     WHERE s.category = 'integration_plugin_egress_policy'
  LOOP
    SELECT jsonb_agg(DISTINCT host_value ORDER BY host_value)
      INTO v_next_denylist
      FROM (
        SELECT value AS host_value
          FROM jsonb_array_elements_text(COALESCE(v_row.value->'domain_denylist', '[]'::jsonb))
        UNION ALL
        SELECT value AS host_value
          FROM jsonb_array_elements_text(v_placeholder_hosts)
      ) AS hosts;

    v_next_value := jsonb_set(
      COALESCE(v_row.value, '{}'::jsonb),
      '{domain_denylist}',
      COALESCE(v_next_denylist, '[]'::jsonb),
      TRUE
    );

    PERFORM public.upsert_settings_value_v1(
      v_row.category,
      v_row.scope_type,
      v_row.scope_id,
      v_next_value,
      COALESCE(v_row.schema_version, 1),
      'Plugin Studio egress placeholder-host denylist'
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'integration_plugin_egress_policy'
       AND scope_type = public.get_root_scope_type_key_v1()
       AND scope_id IS NULL
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_egress_policy',
      public.get_root_scope_type_key_v1(),
      NULL,
      v_schema_example,
      1,
      'Plugin Studio egress placeholder-host denylist'
    );
  END IF;
END;
$policy$;

CREATE OR REPLACE FUNCTION public.integration_plugin_egress_policy_preview_v1(
  p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_winning_scope_type TEXT;
  v_winning_scope_id UUID;
  v_value JSONB;
  v_version INT;
  v_scope_path JSONB;
  v_resolution_id UUID;
  v_requested_scope_type TEXT := CASE WHEN p_organization_id IS NULL THEN public.get_root_scope_type_key_v1() ELSE 'tenant' END;
BEGIN
  SELECT settings_id, settings_version_id, scope_type, scope_id, value, version, scope_path
    INTO v_settings_id, v_settings_version_id, v_winning_scope_type, v_winning_scope_id, v_value, v_version, v_scope_path
    FROM public.resolve_settings_row(
      'integration_plugin_egress_policy',
      v_requested_scope_type,
      p_organization_id
    )
   LIMIT 1;

  IF v_value IS NULL THEN
    v_value := public.integration_plugin_resolve_policy_v1(
      'integration_plugin_egress_policy',
      p_organization_id
    );
  END IF;

  IF v_value IS NULL OR v_value = '{}'::jsonb THEN
    RAISE EXCEPTION 'integration_plugin_egress_policy_preview_v1 settings not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_organization_id IS NOT NULL THEN
    v_resolution_id := public.log_settings_resolution(
      p_organization_id := p_organization_id,
      p_category := 'integration_plugin_egress_policy',
      p_winning_scope_type := v_winning_scope_type,
      p_winning_scope_id := v_winning_scope_id,
      p_winning_settings_id := v_settings_id,
      p_winning_settings_version_id := v_settings_version_id,
      p_winning_version := v_version,
      p_scope_path := v_scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'scope_type', v_requested_scope_type,
        'scope_id', p_organization_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'category', 'integration_plugin_egress_policy',
    'scope_type', v_winning_scope_type,
    'scope_id', v_winning_scope_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'settings_resolution_id', v_resolution_id,
    'scope_path', COALESCE(v_scope_path, '[]'::jsonb),
    'value', v_value
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.integration_plugin_egress_policy_preview_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_egress_policy_preview_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.integration_plugin_egress_policy_preview_v1(UUID) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.integration_plugin_egress_policy_preview_v1(
  p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.integration_plugin_egress_policy_preview_v1(p_organization_id);
$function$;

REVOKE ALL ON FUNCTION api.integration_plugin_egress_policy_preview_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.integration_plugin_egress_policy_preview_v1(UUID) FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.integration_plugin_egress_policy_preview_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605260230_plugin_studio_egress_placeholder_diagnostics_v1'));

COMMIT;
