BEGIN;
SELECT pg_advisory_xact_lock(hashtext('20260909232000_map_policy_tenant_scope_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.map_policy_context_uuid_v1(
  p_context JSONB,
  p_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_value TEXT;
BEGIN
  IF jsonb_typeof(v_context) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'map_policy context must be a JSON object';
  END IF;

  IF p_key IS NULL OR NOT (v_context ? p_key) THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_context -> p_key) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'map_policy context contains an invalid scoped identifier';
  END IF;

  v_value := btrim(COALESCE(v_context ->> p_key, ''));
  IF v_value = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'map_policy context contains an invalid scoped identifier';
  END IF;

  BEGIN
    RETURN v_value::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'map_policy context contains an invalid scoped identifier';
  END;
END;
$function$;

COMMENT ON FUNCTION public.map_policy_context_uuid_v1(JSONB, TEXT) IS
  'Internal map-policy helper that parses an explicitly supplied policy-context identifier without silently falling back on malformed input.';
REVOKE ALL ON FUNCTION public.map_policy_context_uuid_v1(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.map_policy_assert_context_scope_v1(p_context JSONB)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_organization_id UUID := public.map_policy_context_uuid_v1(v_context, 'organization_id');
  v_client_id UUID := public.map_policy_context_uuid_v1(v_context, 'client_id');
  v_sender_id UUID := public.map_policy_context_uuid_v1(v_context, 'sender_id');
  v_source_id UUID := public.map_policy_context_uuid_v1(v_context, 'webhook_source_id');
  v_resource_id UUID := public.map_policy_context_uuid_v1(v_context, 'resource_id');
  v_target_org_id UUID := NULL;
  v_scope_org_id UUID := NULL;
  v_caller_org_id UUID := NULL;
  v_resource_relation REGCLASS := NULL;
BEGIN
  IF jsonb_typeof(v_context) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'map_policy context must be a JSON object';
  END IF;

  IF v_organization_id IS NOT NULL THEN
    SELECT o.id
      INTO v_scope_org_id
      FROM public.organizations o
     WHERE o.id = v_organization_id;

    IF v_scope_org_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'map_policy context is outside the permitted organization scope';
    END IF;
    v_target_org_id := v_scope_org_id;
  END IF;

  IF v_client_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_scope_org_id
      FROM public.clients c
     WHERE c.id = v_client_id;

    IF v_scope_org_id IS NULL
       OR (v_target_org_id IS NOT NULL AND v_target_org_id IS DISTINCT FROM v_scope_org_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'map_policy context is outside the permitted organization scope';
    END IF;
    v_target_org_id := COALESCE(v_target_org_id, v_scope_org_id);
  END IF;

  IF v_sender_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_scope_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_sender_id;

    IF v_scope_org_id IS NULL
       OR (v_target_org_id IS NOT NULL AND v_target_org_id IS DISTINCT FROM v_scope_org_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'map_policy context is outside the permitted organization scope';
    END IF;
    v_target_org_id := COALESCE(v_target_org_id, v_scope_org_id);
  END IF;

  IF v_source_id IS NOT NULL THEN
    SELECT ws.organization_id
      INTO v_scope_org_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_source_id;

    IF v_scope_org_id IS NULL
       OR (v_target_org_id IS NOT NULL AND v_target_org_id IS DISTINCT FROM v_scope_org_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'map_policy context is outside the permitted organization scope';
    END IF;
    v_target_org_id := COALESCE(v_target_org_id, v_scope_org_id);
  END IF;

  IF v_resource_id IS NOT NULL THEN
    SELECT scr.resource_scope_rel
      INTO v_resource_relation
      FROM public.settings_category_registry scr
     WHERE scr.category = 'map_policy';

    IF v_resource_relation IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'map_policy context is outside the permitted organization scope';
    END IF;

    BEGIN
      v_scope_org_id := NULL;
      EXECUTE format('SELECT organization_id FROM %s WHERE id = $1', v_resource_relation)
        INTO v_scope_org_id
        USING v_resource_id;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'map_policy context is outside the permitted organization scope';
    END;

    IF v_scope_org_id IS NULL
       OR (v_target_org_id IS NOT NULL AND v_target_org_id IS DISTINCT FROM v_scope_org_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'map_policy context is outside the permitted organization scope';
    END IF;
    v_target_org_id := COALESCE(v_target_org_id, v_scope_org_id);
  END IF;

  IF v_target_org_id IS NULL THEN
    RETURN;
  END IF;

  IF COALESCE(public.request_is_service_role_v1(), FALSE)
     OR COALESCE(public.is_platform_user(), FALSE) THEN
    RETURN;
  END IF;

  v_caller_org_id := public.current_user_org_id();
  IF v_caller_org_id IS NULL OR v_caller_org_id IS DISTINCT FROM v_target_org_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'map_policy context is outside the permitted organization scope';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.map_policy_assert_context_scope_v1(JSONB) IS
  'Internal fail-closed organization-lineage assertion for shared Console and FieldOps map-policy resolution. Service detection is JWT-claim driven.';
REVOKE ALL ON FUNCTION public.map_policy_assert_context_scope_v1(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.map_policy_assert_scope_path_v1(p_scope_path JSONB)
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
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'map_policy resolver produced an invalid scope path';
  END IF;

  IF jsonb_array_length(p_scope_path) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'map_policy resolver produced an invalid scope path';
  END IF;

  FOR v_entry IN
    SELECT entry.value
      FROM jsonb_array_elements(p_scope_path) entry(value)
  LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_entry -> 'scope_type') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'map_policy resolver produced an invalid scope path';
    END IF;

    v_scope_type := v_entry ->> 'scope_type';
    v_context_key := CASE v_scope_type
      WHEN 'tenant' THEN 'organization_id'
      WHEN 'client' THEN 'client_id'
      WHEN 'sender' THEN 'sender_id'
      WHEN 'source' THEN 'webhook_source_id'
      WHEN 'resource' THEN 'resource_id'
      ELSE NULL
    END;

    IF v_scope_type = 'global' THEN
      IF v_entry -> 'scope_id' IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'map_policy resolver produced an invalid scope path';
      END IF;
      v_global_count := v_global_count + 1;
      CONTINUE;
    END IF;

    IF v_context_key IS NULL
       OR jsonb_typeof(v_entry -> 'scope_id') IS DISTINCT FROM 'string'
       OR v_context ? v_context_key THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'map_policy resolver produced an invalid scope path';
    END IF;

    v_context := jsonb_set(
      v_context,
      ARRAY[v_context_key],
      v_entry -> 'scope_id',
      TRUE
    );
  END LOOP;

  IF v_global_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'map_policy resolver produced an invalid scope path';
  END IF;

  PERFORM public.map_policy_assert_context_scope_v1(v_context);
END;
$function$;

COMMENT ON FUNCTION public.map_policy_assert_scope_path_v1(JSONB) IS
  'Internal fail-closed validation of every tenant-derived scope evaluated by the canonical map-policy resolver.';
REVOKE ALL ON FUNCTION public.map_policy_assert_scope_path_v1(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_map_policy(p_context JSONB)
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
  v_row RECORD;
BEGIN
  PERFORM public.map_policy_assert_context_scope_v1(p_context);

  SELECT resolved.*
  INTO v_row
  FROM public.resolve_settings_row_from_policy_context_v1('map_policy', p_context) resolved
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM public.map_policy_assert_scope_path_v1(v_row.scope_path);

  RETURN QUERY SELECT
    v_row.settings_id,
    v_row.settings_version_id,
    v_row.scope_type,
    v_row.scope_id,
    v_row.value,
    v_row.version,
    v_row.scope_path;
END;
$function$;

COMMENT ON FUNCTION public.resolve_map_policy(JSONB) IS
  'Resolve map_policy via the canonical ladder after a fail-closed caller organization assertion, validate every evaluated scope without changing tile capability.';
REVOKE ALL ON FUNCTION public.resolve_map_policy(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_map_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_settings_row_from_policy_context_v1(
  p_category TEXT,
  p_context JSONB
)
RETURNS TABLE(
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INTEGER,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_category = 'map_policy' THEN
    RETURN QUERY
    SELECT *
    FROM public.resolve_map_policy(p_context);
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1(p_category, p_context);
END;
$function$;

REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  TO service_role;

COMMENT ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) IS
  'Service-only shared policy resolver. map_policy delegates to its scoped resolver; unrelated categories retain the canonical generic path.';

COMMIT;
