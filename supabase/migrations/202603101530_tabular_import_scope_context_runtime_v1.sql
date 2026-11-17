-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Generic scope-aware tabular import context resolution
--
-- Purpose:
--   - Let the importer run against an explicitly chosen organization/client/sender
--     without hardcoding resource-specific branches.
--   - Keep the browser route, edge facade, and SQL dry-run path aligned through
--     one authoritative scope resolver.
--   - Allow platform users to prepare/import for another tenant while keeping
--     tenant/client/sender scoped users fail-closed.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603101530_tabular_import_scope_context_runtime_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_resolve_import_scope_context_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_scope_context JSONB := CASE
    WHEN jsonb_typeof(v_payload->'scope_context') = 'object' THEN COALESCE(v_payload->'scope_context', '{}'::jsonb)
    WHEN jsonb_typeof(v_payload) = 'object' THEN v_payload
    ELSE '{}'::jsonb
  END;
  v_scope_type TEXT := lower(COALESCE(public.current_user_scope_type(), ''));
  v_scope_id UUID := public.current_user_scope_id();
  v_home_org_id UUID := public.current_user_org_id();
  v_requested_org_id UUID := public.mapping_studio_try_uuid_v1(v_scope_context->>'tenant');
  v_requested_client_id UUID := public.mapping_studio_try_uuid_v1(v_scope_context->>'client');
  v_requested_sender_id UUID := public.mapping_studio_try_uuid_v1(v_scope_context->>'sender');
  v_resolved_org_id UUID := NULL;
  v_resolved_client_id UUID := NULL;
  v_resolved_sender_id UUID := NULL;
  v_client_org_id UUID := NULL;
  v_sender_client_id UUID := NULL;
  v_sender_org_id UUID := NULL;
  v_scope_label TEXT := NULL;
BEGIN
  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_requested_client_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_client_org_id
      FROM public.clients c
     WHERE c.id = v_requested_client_id;

    IF v_client_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 unknown client %', v_requested_client_id;
    END IF;
  END IF;

  IF v_requested_sender_id IS NOT NULL THEN
    SELECT s.client_id, c.organization_id
      INTO v_sender_client_id, v_sender_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_requested_sender_id;

    IF v_sender_client_id IS NULL OR v_sender_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 unknown sender %', v_requested_sender_id;
    END IF;
  END IF;

  IF v_requested_sender_id IS NOT NULL THEN
    v_resolved_sender_id := v_requested_sender_id;
    v_resolved_client_id := v_sender_client_id;
    v_resolved_org_id := v_sender_org_id;
  END IF;

  IF v_requested_client_id IS NOT NULL THEN
    IF v_resolved_client_id IS NOT NULL AND v_resolved_client_id IS DISTINCT FROM v_requested_client_id THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 sender/client mismatch';
    END IF;
    IF v_resolved_org_id IS NOT NULL AND v_resolved_org_id IS DISTINCT FROM v_client_org_id THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 client/organization mismatch';
    END IF;
    v_resolved_client_id := COALESCE(v_resolved_client_id, v_requested_client_id);
    v_resolved_org_id := COALESCE(v_resolved_org_id, v_client_org_id);
  END IF;

  IF v_requested_org_id IS NOT NULL THEN
    IF v_resolved_org_id IS NOT NULL AND v_resolved_org_id IS DISTINCT FROM v_requested_org_id THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 requested organization does not match derived client/sender organization';
    END IF;
    v_resolved_org_id := COALESCE(v_resolved_org_id, v_requested_org_id);
  END IF;

  IF public.is_platform_user() THEN
    v_resolved_org_id := COALESCE(v_resolved_org_id, v_home_org_id);
  ELSIF v_scope_type = 'sender' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 sender scope requires current sender context';
    END IF;

    SELECT s.client_id, c.organization_id
      INTO v_sender_client_id, v_sender_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_scope_id;

    IF v_sender_client_id IS NULL OR v_sender_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 current sender scope could not be resolved';
    END IF;

    IF v_resolved_sender_id IS NOT NULL AND v_resolved_sender_id IS DISTINCT FROM v_scope_id THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 cannot import outside the current sender scope';
    END IF;
    IF v_resolved_client_id IS NOT NULL AND v_resolved_client_id IS DISTINCT FROM v_sender_client_id THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 sender scope does not match the requested client';
    END IF;
    IF v_resolved_org_id IS NOT NULL AND v_resolved_org_id IS DISTINCT FROM v_sender_org_id THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 sender scope does not match the requested organization';
    END IF;

    v_resolved_sender_id := v_scope_id;
    v_resolved_client_id := v_sender_client_id;
    v_resolved_org_id := v_sender_org_id;
  ELSIF v_scope_type = 'client' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 client scope requires current client context';
    END IF;

    SELECT c.organization_id
      INTO v_client_org_id
      FROM public.clients c
     WHERE c.id = v_scope_id;

    IF v_client_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 current client scope could not be resolved';
    END IF;

    IF v_resolved_client_id IS NOT NULL AND v_resolved_client_id IS DISTINCT FROM v_scope_id THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 cannot import outside the current client scope';
    END IF;
    IF v_resolved_org_id IS NOT NULL AND v_resolved_org_id IS DISTINCT FROM v_client_org_id THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 client scope does not match the requested organization';
    END IF;
    IF v_resolved_sender_id IS NOT NULL THEN
      SELECT s.client_id
        INTO v_sender_client_id
        FROM public.senders s
       WHERE s.id = v_resolved_sender_id;
      IF v_sender_client_id IS DISTINCT FROM v_scope_id THEN
        RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 requested sender is outside the current client scope';
      END IF;
    END IF;

    v_resolved_client_id := v_scope_id;
    v_resolved_org_id := v_client_org_id;
  ELSE
    IF v_home_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 requires an organization context';
    END IF;

    IF NOT public.is_platform_user() THEN
      IF v_resolved_org_id IS NOT NULL AND v_resolved_org_id IS DISTINCT FROM v_home_org_id THEN
        RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 cannot import outside the current organization scope';
      END IF;
      v_resolved_org_id := v_home_org_id;
    END IF;

    IF v_resolved_client_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_client_org_id
        FROM public.clients c
       WHERE c.id = v_resolved_client_id;
      IF v_client_org_id IS DISTINCT FROM v_resolved_org_id THEN
        RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 requested client is outside the resolved organization scope';
      END IF;
    END IF;

    IF v_resolved_sender_id IS NOT NULL THEN
      SELECT s.client_id, c.organization_id
        INTO v_sender_client_id, v_sender_org_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_resolved_sender_id;
      IF v_sender_org_id IS DISTINCT FROM v_resolved_org_id THEN
        RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 requested sender is outside the resolved organization scope';
      END IF;
      IF v_resolved_client_id IS NOT NULL AND v_resolved_client_id IS DISTINCT FROM v_sender_client_id THEN
        RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 requested sender is outside the requested client scope';
      END IF;
    END IF;
  END IF;

  IF v_resolved_sender_id IS NOT NULL AND v_resolved_client_id IS NULL THEN
    SELECT s.client_id
      INTO v_resolved_client_id
      FROM public.senders s
     WHERE s.id = v_resolved_sender_id;
  END IF;

  IF v_resolved_client_id IS NOT NULL AND v_resolved_org_id IS NULL THEN
    SELECT c.organization_id
      INTO v_resolved_org_id
      FROM public.clients c
     WHERE c.id = v_resolved_client_id;
  END IF;

  IF v_resolved_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_resolve_import_scope_context_v1 could not resolve a target organization';
  END IF;

  v_scope_label := CASE
    WHEN v_resolved_sender_id IS NOT NULL THEN 'sender'
    WHEN v_resolved_client_id IS NOT NULL THEN 'client'
    ELSE 'tenant'
  END;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'organization_id', v_resolved_org_id,
      'client_id', v_resolved_client_id,
      'sender_id', v_resolved_sender_id,
      'scope_type', v_scope_label,
      'scope_context', jsonb_strip_nulls(
        jsonb_build_object(
          'tenant', v_resolved_org_id,
          'client', v_resolved_client_id,
          'sender', v_resolved_sender_id
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_resolve_import_scope_context_v1(JSONB)
  IS 'Resolve and authorize the effective organization/client/sender context for a generic tabular import run.';

CREATE OR REPLACE FUNCTION public.ui_tabular_import_profiles_v1(
  p_resource TEXT,
  p_scope_context JSONB
)
RETURNS TABLE (
  id UUID,
  profile_name TEXT,
  profile_slug TEXT,
  header_fingerprint TEXT,
  sheet_hint TEXT,
  write_mode TEXT,
  mapping_key TEXT,
  mapping_config JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_resource_key TEXT := NULLIF(btrim(COALESCE(p_resource, '')), '');
  v_scope_resolution JSONB := public.ui_resolve_import_scope_context_v1(
    jsonb_build_object('scope_context', COALESCE(p_scope_context, '{}'::jsonb))
  );
  v_org_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>'organization_id');
  v_resource JSONB;
  v_capability TEXT;
BEGIN
  IF v_resource_key IS NULL THEN
    RAISE EXCEPTION 'ui_tabular_import_profiles_v1 requires resource key';
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_tabular_import_profiles_v1 requires organization scope';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);
  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_tabular_import_profiles_v1 unknown resource %', v_resource_key;
  END IF;

  IF COALESCE((v_resource#>>ARRAY['import','enabled'])::boolean, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_tabular_import_profiles_v1 import disabled for resource %', v_resource_key;
  END IF;

  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), '')
  );
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, 'tenant', v_org_id);
  END IF;

  RETURN QUERY
  SELECT
    mc.id,
    NULLIF(btrim(COALESCE(mc.mapping_config->>'profile_name', '')), '') AS profile_name,
    public.tabular_import_slug_v1(
      COALESCE(
        NULLIF(btrim(COALESCE(mc.mapping_config->>'profile_name', '')), ''),
        split_part(mc.mapping_key, '::', 3)
      )
    ) AS profile_slug,
    NULLIF(btrim(COALESCE(mc.mapping_config->>'header_fingerprint', '')), '') AS header_fingerprint,
    NULLIF(btrim(COALESCE(mc.mapping_config->>'sheet_hint', '')), '') AS sheet_hint,
    COALESCE(NULLIF(btrim(COALESCE(mc.mapping_config->>'write_mode', '')), ''), 'create') AS write_mode,
    mc.mapping_key,
    mc.mapping_config,
    mc.created_at,
    mc.updated_at
  FROM public.mapping_configs mc
  WHERE mc.organization_id = v_org_id
    AND mc.mapping_type = 'tabular_import'
    AND COALESCE(mc.mapping_config->>'resource_key', '') = v_resource_key
  ORDER BY mc.updated_at DESC, mc.created_at DESC;
END;
$function$;

COMMENT ON FUNCTION public.ui_tabular_import_profiles_v1(TEXT, JSONB)
  IS 'List reusable tabular import profiles for the resolved import organization context.';

DO $$
DECLARE
  v_function_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.tabular_import_prepare_base_v1(jsonb)'::regprocedure)
    INTO v_function_def;

  IF v_function_def IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_base_v1(jsonb) not found';
  END IF;

  v_function_def := replace(
    v_function_def,
    '  v_user_id UUID := auth.uid();' || E'\n' ||
    '  v_org_id UUID := public.current_user_org_id();' || E'\n' ||
    '  v_client_id UUID := public.current_user_client_id();' || E'\n' ||
    '  v_sender_id UUID := public.current_user_sender_id();',
    '  v_user_id UUID := auth.uid();' || E'\n' ||
    '  v_scope_resolution JSONB := public.ui_resolve_import_scope_context_v1(v_payload);' || E'\n' ||
    '  v_org_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>''organization_id'');' || E'\n' ||
    '  v_client_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>''client_id'');' || E'\n' ||
    '  v_sender_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>''sender_id'');'
  );

  v_function_def := replace(
    v_function_def,
    'FROM public.ui_tabular_import_profiles_v1(v_resource_key) profile;',
    'FROM public.ui_tabular_import_profiles_v1(v_resource_key, COALESCE(v_payload->''scope_context'', ''{}''::jsonb)) profile;'
  );

  EXECUTE v_function_def;
END $$;

CREATE OR REPLACE FUNCTION public.tabular_import_prepare_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_original_headers JSONB := COALESCE(v_payload->'headers', '[]'::jsonb);
  v_candidate_rules JSONB := COALESCE(v_payload->'rules', '[]'::jsonb);
  v_selected_rules JSONB := '[]'::jsonb;
  v_profile_match JSONB := NULL;
  v_rule_source TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'rule_source', '')), ''), 'auto'));
  v_effective_rule_source TEXT := CASE WHEN v_rule_source = 'manual' THEN 'manual' ELSE 'auto' END;
  v_resource_key TEXT := NULLIF(btrim(COALESCE(v_payload->>'resource_key', '')), '');
  v_header_fingerprint TEXT := NULLIF(btrim(COALESCE(v_payload->>'header_fingerprint', '')), '');
  v_scope_resolution JSONB := public.ui_resolve_import_scope_context_v1(v_payload);
  v_result JSONB;
  v_run_id UUID;
  v_row_override_count INT := 0;
BEGIN
  IF jsonb_typeof(v_candidate_rules) = 'array' AND jsonb_array_length(v_candidate_rules) > 0 THEN
    v_selected_rules := v_candidate_rules;
  END IF;

  IF v_rule_source <> 'manual' AND v_resource_key IS NOT NULL THEN
    IF v_header_fingerprint IS NULL THEN
      SELECT string_agg(normalized_header, '|' ORDER BY normalized_header)
        INTO v_header_fingerprint
        FROM (
          SELECT regexp_replace(lower(btrim(value)), '[^a-z0-9]+', '_', 'g') AS normalized_header
          FROM jsonb_array_elements_text(COALESCE(v_original_headers, '[]'::jsonb)) AS value
          WHERE NULLIF(btrim(value), '') IS NOT NULL
        ) normalized;
    END IF;

    SELECT value
      INTO v_profile_match
      FROM (
        SELECT jsonb_build_object(
          'id', profile.id,
          'profile_name', profile.profile_name,
          'profile_slug', profile.profile_slug,
          'header_fingerprint', profile.header_fingerprint,
          'sheet_hint', profile.sheet_hint,
          'write_mode', profile.write_mode,
          'mapping_key', profile.mapping_key,
          'mapping_config', profile.mapping_config,
          'created_at', profile.created_at,
          'updated_at', profile.updated_at
        ) AS value
        FROM public.ui_tabular_import_profiles_v1(
          v_resource_key,
          COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb)
        ) AS profile
      ) profiles
     WHERE COALESCE(value->>'header_fingerprint', '') = COALESCE(v_header_fingerprint, '')
     ORDER BY COALESCE(value->>'updated_at', value->>'created_at', '') DESC
     LIMIT 1;

    IF v_profile_match IS NOT NULL
       AND jsonb_typeof(v_profile_match#>'{mapping_config,field_rules}') = 'array'
       AND jsonb_array_length(v_profile_match#>'{mapping_config,field_rules}') > 0 THEN
      v_selected_rules := COALESCE(v_profile_match#>'{mapping_config,field_rules}', '[]'::jsonb);
      v_effective_rule_source := 'profile';
    END IF;
  END IF;

  IF jsonb_typeof(v_selected_rules) IS DISTINCT FROM 'array' THEN
    v_selected_rules := '[]'::jsonb;
  END IF;

  IF jsonb_typeof(v_payload->'row_overrides') = 'object' THEN
    SELECT count(*)
      INTO v_row_override_count
      FROM jsonb_each(v_payload->'row_overrides') AS row_entry(row_key, row_value)
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(row_entry.row_value) = 'object' THEN row_entry.row_value
          ELSE '{}'::jsonb
        END
      ) AS field_entry(key, value);
  END IF;

  v_payload := jsonb_set(v_payload, '{rules}', v_selected_rules, TRUE);
  v_payload := jsonb_set(
    v_payload,
    '{scope_context}',
    COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb),
    TRUE
  );
  IF v_header_fingerprint IS NOT NULL THEN
    v_payload := jsonb_set(v_payload, '{header_fingerprint}', to_jsonb(v_header_fingerprint), TRUE);
  END IF;

  v_result := public.tabular_import_prepare_base_v1(
    public.tabular_import_materialize_row_overrides_v1(
      public.tabular_import_materialize_fixed_rules_v1(v_payload)
    )
  );

  v_run_id := public.mapping_studio_try_uuid_v1(v_result->>'run_id');
  IF v_run_id IS NOT NULL THEN
    UPDATE public.tabular_import_runs
       SET summary = jsonb_strip_nulls(
             COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
               'headers', COALESCE(v_original_headers, '[]'::jsonb),
               'resolved_rules', COALESCE(v_selected_rules, '[]'::jsonb),
               'rule_source', v_effective_rule_source,
               'row_override_count', v_row_override_count,
               'scope_context', COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb)
             )
           ),
           updated_at = now()
     WHERE id = v_run_id;
  END IF;

  IF jsonb_typeof(v_result) = 'object' THEN
    v_result := jsonb_set(v_result, '{resolved_rules}', COALESCE(v_selected_rules, '[]'::jsonb), TRUE);
  END IF;

  RETURN v_result;
END;
$function$;

DROP POLICY IF EXISTS tabular_import_runs_select ON public.tabular_import_runs;
CREATE POLICY tabular_import_runs_select
ON public.tabular_import_runs
FOR SELECT
TO authenticated
USING (
  public.user_can_write()
  AND (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  )
);

DROP POLICY IF EXISTS tabular_import_runs_insert ON public.tabular_import_runs;
CREATE POLICY tabular_import_runs_insert
ON public.tabular_import_runs
FOR INSERT
TO authenticated
WITH CHECK (
  public.user_can_write()
  AND (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  )
);

DROP POLICY IF EXISTS tabular_import_runs_update ON public.tabular_import_runs;
CREATE POLICY tabular_import_runs_update
ON public.tabular_import_runs
FOR UPDATE
TO authenticated
USING (
  public.user_can_write()
  AND (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  )
)
WITH CHECK (
  public.user_can_write()
  AND (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  )
);

DROP POLICY IF EXISTS tabular_import_run_rows_select ON public.tabular_import_run_rows;
CREATE POLICY tabular_import_run_rows_select
ON public.tabular_import_run_rows
FOR SELECT
TO authenticated
USING (
  public.user_can_write()
  AND (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  )
);

DROP POLICY IF EXISTS tabular_import_run_rows_insert ON public.tabular_import_run_rows;
CREATE POLICY tabular_import_run_rows_insert
ON public.tabular_import_run_rows
FOR INSERT
TO authenticated
WITH CHECK (
  public.user_can_write()
  AND (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  )
);

DROP POLICY IF EXISTS tabular_import_run_rows_update ON public.tabular_import_run_rows;
CREATE POLICY tabular_import_run_rows_update
ON public.tabular_import_run_rows
FOR UPDATE
TO authenticated
USING (
  public.user_can_write()
  AND (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  )
)
WITH CHECK (
  public.user_can_write()
  AND (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  )
);

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.ui_resolve_import_scope_context_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_resolve_import_scope_context_v1($1);
$function$;

CREATE OR REPLACE FUNCTION api.ui_tabular_import_profiles_v1(
  p_resource TEXT,
  p_scope_context JSONB
)
RETURNS TABLE (
  id UUID,
  profile_name TEXT,
  profile_slug TEXT,
  header_fingerprint TEXT,
  sheet_hint TEXT,
  write_mode TEXT,
  mapping_key TEXT,
  mapping_config JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
    FROM public.ui_tabular_import_profiles_v1($1, $2);
$function$;

REVOKE ALL ON FUNCTION public.ui_resolve_import_scope_context_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_resolve_import_scope_context_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_tabular_import_profiles_v1(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_tabular_import_profiles_v1(TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_resolve_import_scope_context_v1(JSONB) FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_resolve_import_scope_context_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_tabular_import_profiles_v1(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_tabular_import_profiles_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603101530_tabular_import_scope_context_runtime_v1'));

COMMIT;
