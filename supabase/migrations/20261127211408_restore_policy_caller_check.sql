BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE FUNCTION public.settings_policy_assert_context_scope_v1(
  p_category TEXT,
  p_context JSONB,
  p_scope_path JSONB DEFAULT NULL,
  p_bound_org UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_map_context BOOLEAN := p_category = 'map_policy' AND p_scope_path IS NULL;
  v_claims JSONB := COALESCE(auth.jwt(), '{}'::jsonb);
  v_subject TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.sub', TRUE), ''),
                             NULLIF(v_claims ->> 'sub', ''));
  v_claim_role TEXT := COALESCE(NULLIF(v_claims ->> 'role', ''),
                                NULLIF(current_setting('request.jwt.claim.role', TRUE), ''));
  v_sql_role TEXT := COALESCE(NULLIF(current_setting('role', TRUE), 'none'), session_user);
  v_has_jwt BOOLEAN := v_claim_role IS NOT NULL OR v_subject IS NOT NULL OR v_claims <> '{}'::jsonb;
  v_role TEXT := CASE WHEN v_has_jwt THEN v_claim_role ELSE v_sql_role END;
  v_has_uuid_subject BOOLEAN := public.mapping_studio_try_uuid_v1(v_subject) IS NOT NULL
    AND (v_claims ->> 'sub' IS NULL OR public.mapping_studio_try_uuid_v1(v_claims ->> 'sub') IS NOT NULL);
  v_has_privileged_scope BOOLEAN := FALSE;
  v_target_org UUID;
  v_scope_org UUID;
  v_allowed_org UUID;
  v_resource_rel REGCLASS;
  v_scope RECORD;
BEGIN
  IF jsonb_typeof(v_context) IS DISTINCT FROM 'object' THEN
    IF v_map_context THEN
      RAISE EXCEPTION 'map_policy context must be a JSON object' USING ERRCODE = '22023';
    END IF;
    v_context := '{}'::jsonb;
  END IF;

  -- A request retains its identity inside a definer. SQL service calls need no JWT.
  v_has_privileged_scope := COALESCE(v_role = 'service_role', FALSE)
    OR COALESCE(v_role = 'edge_label_renderer_role' AND p_scope_path IS NOT NULL
                AND p_category IN ('label_design', 'label_print_policy', 'shipment_reference_policy'), FALSE);
  IF NOT v_has_privileged_scope AND v_has_uuid_subject THEN
    v_has_privileged_scope := COALESCE(public.is_platform_user(), FALSE);
  END IF;

  IF p_bound_org IS NULL AND NOT v_map_context AND (v_has_privileged_scope
      OR (NOT v_has_jwt AND session_user IN ('postgres', 'supabase_admin') AND v_sql_role = session_user)) THEN
    RETURN;
  END IF;

  FOR v_scope IN
    SELECT selector.scope_type,
           CASE WHEN v_map_context THEN public.map_policy_context_uuid_v1(v_context, selector.context_key)
                ELSE public.mapping_studio_try_uuid_v1(v_context ->> selector.context_key)
           END AS scope_id
      FROM (VALUES ('tenant', 'organization_id'), ('client', 'client_id'), ('sender', 'sender_id'),
                   ('source', 'webhook_source_id'), ('resource', 'resource_id')) selector(scope_type, context_key)
     WHERE p_scope_path IS NULL AND v_context ? selector.context_key
    UNION
    SELECT r.scope_type, public.mapping_studio_try_uuid_v1(v_context ->> k.context_key)
      FROM public.scope_type_registry r
      CROSS JOIN LATERAL jsonb_array_elements_text(r.context_keys) k(context_key)
     WHERE p_scope_path IS NOT NULL AND r.is_enabled AND r.entity_table IS NOT NULL
       AND v_context ? k.context_key
    UNION
    SELECT entry ->> 'scope_type', public.mapping_studio_try_uuid_v1(entry ->> 'scope_id')
      FROM jsonb_array_elements(p_scope_path) AS path(entry)
  LOOP
    CONTINUE WHEN v_scope.scope_id IS NULL;

    IF v_scope.scope_type = 'tenant' THEN
      SELECT id INTO v_scope_org FROM public.organizations WHERE id = v_scope.scope_id;
    ELSIF p_scope_path IS NOT NULL THEN
      v_scope_org := public.resolve_organization_id_for_scope_v1(v_scope.scope_type, v_scope.scope_id);
    ELSIF v_scope.scope_type = 'client' THEN
      SELECT organization_id INTO v_scope_org FROM public.clients WHERE id = v_scope.scope_id;
    ELSIF v_scope.scope_type = 'sender' THEN
      SELECT c.organization_id INTO v_scope_org
        FROM public.senders s JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_scope.scope_id;
    ELSIF v_scope.scope_type = 'source' THEN
      SELECT ws.organization_id INTO v_scope_org
        FROM public.webhook_sources ws
        LEFT JOIN public.senders s ON s.id = ws.sender_id
        LEFT JOIN public.clients c ON c.id = s.client_id
       WHERE ws.id = v_scope.scope_id
         AND (ws.sender_id IS NULL OR c.organization_id = ws.organization_id);
    ELSE
      SELECT resource_scope_rel INTO v_resource_rel
        FROM public.settings_category_registry WHERE category = p_category;
      v_scope_org := NULL;
      IF v_resource_rel IS NOT NULL THEN
        BEGIN
          EXECUTE format('SELECT organization_id FROM %s WHERE id = $1', v_resource_rel)
            INTO v_scope_org USING v_scope.scope_id;
        EXCEPTION WHEN undefined_column OR undefined_table THEN
          v_scope_org := NULL;
        END;
      END IF;
    END IF;

    IF v_scope_org IS NULL OR (v_target_org IS NOT NULL AND v_target_org <> v_scope_org) THEN
      RAISE EXCEPTION 'Policy context is outside the permitted organization scope' USING ERRCODE = '42501';
    END IF;
    v_target_org := v_scope_org;
  END LOOP;

  IF v_target_org IS NULL OR (p_bound_org IS NULL AND v_has_privileged_scope) THEN
    RETURN;
  END IF;

  IF p_bound_org IS NOT NULL THEN
    v_allowed_org := p_bound_org;
  ELSIF v_has_uuid_subject THEN
    v_allowed_org := public.current_user_org_id();
  END IF;
  IF v_allowed_org IS DISTINCT FROM v_target_org THEN
    RAISE EXCEPTION 'Policy context is outside the permitted organization scope' USING ERRCODE = '42501';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.settings_policy_assert_context_scope_v1(TEXT, JSONB, JSONB, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.map_policy_assert_context_scope_v1(p_context JSONB)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  PERFORM public.settings_policy_assert_context_scope_v1('map_policy', p_context);
END;
$function$;

CREATE FUNCTION public.settings_policy_assert_scope_path_v1(p_category TEXT, p_scope_path JSONB)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_entry JSONB;
  v_scope_type TEXT;
  v_context_key TEXT;
  v_context JSONB := '{}'::jsonb;
  v_global_count INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_scope_path) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Policy resolver produced an invalid scope path' USING ERRCODE = '22023';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_scope_path)
  LOOP
    v_scope_type := v_entry ->> 'scope_type';
    v_context_key := CASE v_scope_type
      WHEN 'tenant' THEN 'organization_id'
      WHEN 'client' THEN 'client_id'
      WHEN 'sender' THEN 'sender_id'
      WHEN 'source' THEN 'webhook_source_id'
      WHEN 'resource' THEN 'resource_id'
    END;

    IF v_scope_type = 'global' AND v_entry -> 'scope_id' = 'null'::jsonb THEN
      v_global_count := v_global_count + 1;
    ELSIF v_context_key IS NULL OR jsonb_typeof(v_entry -> 'scope_id') IS DISTINCT FROM 'string'
          OR v_context ? v_context_key THEN
      RAISE EXCEPTION 'Policy resolver produced an invalid scope path' USING ERRCODE = '22023';
    ELSE
      v_context := jsonb_set(v_context, ARRAY[v_context_key], v_entry -> 'scope_id');
    END IF;
  END LOOP;

  IF v_global_count <> 1 THEN
    RAISE EXCEPTION 'Policy resolver produced an invalid scope path' USING ERRCODE = '22023';
  END IF;

  PERFORM public.settings_policy_assert_context_scope_v1(p_category, v_context);
END;
$function$;

REVOKE ALL ON FUNCTION public.settings_policy_assert_scope_path_v1(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.map_policy_assert_scope_path_v1(p_scope_path JSONB)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  PERFORM public.settings_policy_assert_scope_path_v1('map_policy', p_scope_path);
END;
$function$;

-- A stop's policy resource is the branch of its route run.
CREATE OR REPLACE FUNCTION public.resolve_pod_policy(p_context JSONB)
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
DECLARE
  v_context JSONB := p_context;
  v_stop_org UUID;
  v_context_org UUID;
  v_branch_id UUID;
BEGIN
  IF v_context ->> 'resource_type' = 'route_stop' AND v_context ->> 'resource_id' IS NOT NULL THEN
    SELECT s.organization_id, b.id INTO v_stop_org, v_branch_id
    FROM public.route_stops s
    JOIN public.route_runs r ON r.id = s.route_run_id AND r.organization_id = s.organization_id
    LEFT JOIN public.branches b ON b.id = r.branch_id AND b.organization_id = s.organization_id
    WHERE s.id = public.mapping_studio_try_uuid_v1(v_context ->> 'resource_id')
      AND (r.branch_id IS NULL OR b.id IS NOT NULL);

    v_context_org := public.mapping_studio_try_uuid_v1(v_context ->> 'organization_id');
    IF v_stop_org IS NULL OR (v_context_org IS NOT NULL AND v_context_org <> v_stop_org) THEN
      RAISE EXCEPTION 'Policy context is outside the permitted organization scope' USING ERRCODE = '42501';
    END IF;
    v_context := jsonb_strip_nulls(v_context || jsonb_build_object('organization_id', v_stop_org, 'resource_id', v_branch_id));
  END IF;

  RETURN QUERY
  SELECT * FROM public.resolve_settings_row_from_policy_context_v1('pod_policy', v_context);
END;
$function$;

-- Record-bound callers use the same lookup as callers supplying a policy context.
DO $migration$
DECLARE
  v_change RECORD;
  v_definition TEXT;
BEGIN
  v_definition := pg_get_functiondef('public.resolve_settings_row_from_policy_context_v1(text,jsonb)'::regprocedure);
  IF position('FUNCTION public.resolve_settings_row_from_policy_context_v1(' IN v_definition) = 0
     OR position('AS $function$' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected the installed policy lookup definition';
  END IF;
  EXECUTE replace(v_definition,
    'FUNCTION public.resolve_settings_row_from_policy_context_v1(',
    'FUNCTION public.resolve_settings_row_from_bound_policy_context_v1(');
  EXECUTE split_part(v_definition, 'AS $function$', 1) || $checked$AS $function$
BEGIN
  PERFORM public.settings_policy_assert_context_scope_v1(p_category, p_context);
  RETURN QUERY
  SELECT * FROM public.resolve_settings_row_from_bound_policy_context_v1(p_category, p_context);
END;
$function$$checked$;

  FOR v_change IN
    SELECT * FROM (VALUES
      ('public.resolve_settings_row_from_context(text,jsonb)',
       $before$  RETURN QUERY
  SELECT * FROM public.resolve_settings_row(p_category, v_scope_type, v_scope_id) LIMIT 1;$before$,
       $after$  PERFORM public.settings_policy_assert_context_scope_v1(
    p_category, p_context, public.resolve_scope_path_v1(v_scope_type, v_scope_id)
  );

  RETURN QUERY
  SELECT * FROM public.resolve_settings_row(p_category, v_scope_type, v_scope_id) LIMIT 1;$after$),
      ('public.marketplace_policy_lookup_v1(text,jsonb)',
       $before$  WHERE NOT EXISTS (
    SELECT 1
      FROM public.resolve_settings_row_from_policy_context_v1(
        p_category,
        COALESCE(p_context, '{}'::jsonb)
      )
  );$before$,
       $after$  -- Reuse the caller-bound lookup for fallback as well.
  WHERE NOT EXISTS (SELECT 1 FROM resolved);$after$),
      ('public.resolve_map_policy(jsonb)',
       E'  PERFORM public.map_policy_assert_context_scope_v1(p_context);\n\n',
       ''),
      ('public.resolve_mobile_shell_policy(text,jsonb)',
       $before$jsonb_build_object('organization_id', v_caller_org) || v_context$before$,
       $after$v_context || jsonb_build_object('organization_id', v_caller_org)$after$),
      ('public.ensure_task_type_from_catalog_internal_v1(uuid,text,jsonb)',
       'public.resolve_settings_row_from_policy_context_v1(',
       'public.resolve_settings_row_from_bound_policy_context_v1('),
      ('public.compute_delivery_attempt_projection_v1(uuid,uuid,uuid,uuid,text,text,jsonb,timestamptz)',
       'public.resolve_settings_row_from_policy_context_v1(',
       'public.resolve_settings_row_from_bound_policy_context_v1('),
      ('public.resolve_settlement_policy(jsonb)',
       $before$  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('settlement_policy', p_context)$before$,
       $after$  PERFORM public.settings_policy_assert_context_scope_v1(
    'settlement_policy', p_context, NULL, public.mapping_studio_try_uuid_v1(p_context ->> 'organization_id')
  );
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_bound_policy_context_v1('settlement_policy', p_context)$after$),
      ('public.resolve_cod_policy(jsonb)',
       $before$  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('cod_policy', p_context)$before$,
       $after$  PERFORM public.settings_policy_assert_context_scope_v1(
    'cod_policy', p_context, NULL, public.mapping_studio_try_uuid_v1(p_context ->> 'organization_id')
  );
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_bound_policy_context_v1('cod_policy', p_context)$after$),
      ('public.marketplace_award_respond_v1(uuid,text,jsonb)',
       $before$public.marketplace_execution_policy_v1(
         jsonb_build_object('organization_id', v_req.requester_organization_id, 'request_kind_key', v_req.request_kind_key)
       )$before$,
       $after$(SELECT value FROM public.marketplace_policy_lookup_bound_v1(
         'marketplace_execution_policy',
         jsonb_build_object('organization_id', v_req.requester_organization_id, 'request_kind_key', v_req.request_kind_key)
       ))$after$)
    ) AS changes(signature, before_text, after_text)
  LOOP
    v_definition := replace(pg_get_functiondef(v_change.signature::regprocedure), E'\r\n', E'\n');
    IF length(v_definition) - length(replace(v_definition, v_change.before_text, ''))
       <> length(v_change.before_text) THEN
      RAISE EXCEPTION 'Expected one update location in %', v_change.signature;
    END IF;
    EXECUTE replace(v_definition, v_change.before_text, v_change.after_text);
  END LOOP;

  v_definition := pg_get_functiondef('public.marketplace_policy_lookup_v1(text,jsonb)'::regprocedure);
  IF position('FUNCTION public.marketplace_policy_lookup_v1(' IN v_definition) = 0
     OR position('AS $function$' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected the installed marketplace policy lookup definition';
  END IF;
  EXECUTE replace(replace(v_definition,
    'FUNCTION public.marketplace_policy_lookup_v1(',
    'FUNCTION public.marketplace_policy_lookup_bound_v1('),
    'public.resolve_settings_row_from_policy_context_v1(',
    'public.resolve_settings_row_from_bound_policy_context_v1(');
  EXECUTE split_part(v_definition, 'AS $function$', 1) || $checked$AS $function$
BEGIN
  PERFORM public.settings_policy_assert_context_scope_v1(p_category, p_context);
  RETURN QUERY
  SELECT * FROM public.marketplace_policy_lookup_bound_v1(p_category, p_context);
END;
$function$$checked$;
END;
$migration$;

REVOKE ALL ON FUNCTION public.resolve_settings_row_from_bound_policy_context_v1(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.marketplace_policy_lookup_bound_v1(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
