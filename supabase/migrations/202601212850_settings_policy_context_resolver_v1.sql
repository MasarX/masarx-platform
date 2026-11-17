-- Plan: PLAN-202601-settings-policy-context-resolver-v1 / Step: S04
-- Migration: Canonical policy-context settings resolver + commercial terms bundle
-- Date: 2026-01-21
--
-- Goals:
--   - Eliminate duplicated category-specific ladder resolvers by introducing one canonical
--     resolver for "policy contexts" (resource/source/sender/client/tenant/global).
--   - Keep behavior row-driven: scope governance and resource semantics come from
--     settings_category_registry (allowed_scopes + resource_scope_rel).
--   - Provide thin resolver wrappers for commercial terms categories and a bundle helper.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212850_settings_policy_context_resolver_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical resolver: policy context -> winning settings row
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_settings_row_from_policy_context_v1(
  p_category TEXT,
  p_context JSONB
)
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
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_context, '{}'::jsonb);

  v_resource_id UUID := NULL;
  v_source_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_client_id UUID := NULL;
  v_org_id UUID := NULL;

  v_allowed_scopes JSONB := NULL;
  v_resource_rel REGCLASS := NULL;
  v_safe_missing TEXT := NULL;

  v_allow_all BOOLEAN := TRUE;
  v_allow_resource BOOLEAN := TRUE;
  v_allow_source BOOLEAN := TRUE;
  v_allow_sender BOOLEAN := TRUE;
  v_allow_client BOOLEAN := TRUE;
  v_allow_tenant BOOLEAN := TRUE;

  v_scope_path JSONB := '[]'::jsonb;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN;
  END IF;

  IF jsonb_typeof(v_ctx) <> 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  SELECT scr.allowed_scopes,
         scr.resource_scope_rel,
         scr.safe_missing_behavior
    INTO v_allowed_scopes,
         v_resource_rel,
         v_safe_missing
    FROM public.settings_category_registry scr
   WHERE scr.category = p_category
   LIMIT 1;

  v_allow_all := (v_allowed_scopes IS NULL OR jsonb_typeof(v_allowed_scopes) <> 'array');
  v_allow_resource := v_allow_all OR (v_allowed_scopes ? 'resource');
  v_allow_source := v_allow_all OR (v_allowed_scopes ? 'source');
  v_allow_sender := v_allow_all OR (v_allowed_scopes ? 'sender');
  v_allow_client := v_allow_all OR (v_allowed_scopes ? 'client');
  v_allow_tenant := v_allow_all OR (v_allowed_scopes ? 'tenant');

  BEGIN v_resource_id := NULLIF(v_ctx->>'resource_id', '')::UUID; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  BEGIN v_source_id := NULLIF(v_ctx->>'webhook_source_id', '')::UUID; EXCEPTION WHEN others THEN v_source_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_ctx->>'sender_id', '')::UUID; EXCEPTION WHEN others THEN v_sender_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_ctx->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_org_id := NULLIF(v_ctx->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;

  -- Derive chain when higher context is not provided (best-effort; no hardcoding).
  IF v_allow_source AND v_source_id IS NOT NULL AND (v_sender_id IS NULL OR v_org_id IS NULL) THEN
    SELECT ws.sender_id, ws.organization_id
      INTO v_sender_id, v_org_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_source_id;
  END IF;

  IF v_allow_sender AND v_sender_id IS NOT NULL AND v_client_id IS NULL THEN
    SELECT s.client_id
      INTO v_client_id
      FROM public.senders s
     WHERE s.id = v_sender_id;
  END IF;

  IF v_allow_client AND v_client_id IS NOT NULL AND v_org_id IS NULL THEN
    SELECT c.organization_id
      INTO v_org_id
      FROM public.clients c
     WHERE c.id = v_client_id;
  END IF;

  IF v_allow_resource AND v_resource_id IS NOT NULL AND v_org_id IS NULL AND v_resource_rel IS NOT NULL THEN
    BEGIN
      EXECUTE format('SELECT organization_id FROM %s WHERE id = $1', v_resource_rel)
        INTO v_org_id
        USING v_resource_id;
    EXCEPTION
      WHEN others THEN
        -- Best-effort only: if a category declares a resource_scope_rel without organization_id,
        -- tenant fallback must be provided explicitly in context.
        v_org_id := v_org_id;
    END;
  END IF;

  -- Build evaluated scope path (highest precedence -> lowest).
  IF v_allow_resource AND v_resource_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'resource', 'scope_id', v_resource_id));
  END IF;
  IF v_allow_source AND v_source_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'source', 'scope_id', v_source_id));
  END IF;
  IF v_allow_sender AND v_sender_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'sender', 'scope_id', v_sender_id));
  END IF;
  IF v_allow_client AND v_client_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'client', 'scope_id', v_client_id));
  END IF;
  IF v_allow_tenant AND v_org_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'tenant', 'scope_id', v_org_id));
  END IF;
  v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL));

  SELECT ranked.id,
         ranked.settings_version_id,
         ranked.scope_type,
         ranked.scope_id,
         ranked.cached_value,
         ranked.version
    INTO settings_id,
         settings_version_id,
         scope_type,
         scope_id,
         value,
         version
  FROM (
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 1 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_allow_resource
       AND v_resource_id IS NOT NULL
       AND s.category = p_category
       AND s.scope_type = 'resource'
       AND s.scope_id = v_resource_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 2 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_allow_source
       AND v_source_id IS NOT NULL
       AND s.category = p_category
       AND s.scope_type = 'source'
       AND s.scope_id = v_source_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 3 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_allow_sender
       AND v_sender_id IS NOT NULL
       AND s.category = p_category
       AND s.scope_type = 'sender'
       AND s.scope_id = v_sender_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 4 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_allow_client
       AND v_client_id IS NOT NULL
       AND s.category = p_category
       AND s.scope_type = 'client'
       AND s.scope_id = v_client_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 5 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_allow_tenant
       AND v_org_id IS NOT NULL
       AND s.category = p_category
       AND s.scope_type = 'tenant'
       AND s.scope_id = v_org_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 6 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = p_category
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) ranked
  ORDER BY ranked.priority, ranked.id
  LIMIT 1;

  scope_path := v_scope_path;

  IF NOT FOUND THEN
    IF v_safe_missing = 'hard_fail' THEN
      RAISE EXCEPTION 'Missing required settings for category: %', p_category USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) IS
  'Resolve a settings row for a category using standard policy context keys (resource_id/webhook_source_id/sender_id/client_id/organization_id), governed by settings_category_registry; returns winning row + evaluated scope_path.';

REVOKE ALL ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 2) Thin wrappers (remove duplicated ladder logic)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_pricing_policy(
  p_context JSONB
)
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
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('pricing_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_pricing_policy(JSONB) IS
  'Resolve pricing_policy with precedence resource > source > sender > client > tenant > global; thin wrapper over resolve_settings_row_from_policy_context_v1.';

CREATE OR REPLACE FUNCTION public.resolve_shipment_promise_policy(
  p_context JSONB
)
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
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('shipment_promise_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_shipment_promise_policy(JSONB) IS
  'Resolve shipment_promise_policy with precedence resource > source > sender > client > tenant > global; thin wrapper over resolve_settings_row_from_policy_context_v1.';

CREATE OR REPLACE FUNCTION public.resolve_cod_policy(
  p_context JSONB
)
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
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('cod_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_cod_policy(JSONB) IS
  'Resolve cod_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';

REVOKE ALL ON FUNCTION public.resolve_cod_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_cod_policy(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_settlement_policy(
  p_context JSONB
)
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
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('settlement_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_settlement_policy(JSONB) IS
  'Resolve settlement_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';

REVOKE ALL ON FUNCTION public.resolve_settlement_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_settlement_policy(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) Agreement-as-resolution: resolve all commercial terms in one call
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_commercial_terms_v1(
  p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_promise RECORD;
  v_pricing RECORD;
  v_cod RECORD;
  v_settlement RECORD;
BEGIN
  SELECT * INTO v_promise FROM public.resolve_settings_row_from_policy_context_v1('shipment_promise_policy', p_context) LIMIT 1;
  SELECT * INTO v_pricing FROM public.resolve_settings_row_from_policy_context_v1('pricing_policy', p_context) LIMIT 1;
  SELECT * INTO v_cod FROM public.resolve_settings_row_from_policy_context_v1('cod_policy', p_context) LIMIT 1;
  SELECT * INTO v_settlement FROM public.resolve_settings_row_from_policy_context_v1('settlement_policy', p_context) LIMIT 1;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'shipment_promise_policy', CASE WHEN v_promise.settings_id IS NULL THEN NULL ELSE jsonb_build_object(
      'settings_id', v_promise.settings_id,
      'settings_version_id', v_promise.settings_version_id,
      'scope_type', v_promise.scope_type,
      'scope_id', v_promise.scope_id,
      'value', v_promise.value,
      'version', v_promise.version,
      'scope_path', v_promise.scope_path
    ) END,
    'pricing_policy', CASE WHEN v_pricing.settings_id IS NULL THEN NULL ELSE jsonb_build_object(
      'settings_id', v_pricing.settings_id,
      'settings_version_id', v_pricing.settings_version_id,
      'scope_type', v_pricing.scope_type,
      'scope_id', v_pricing.scope_id,
      'value', v_pricing.value,
      'version', v_pricing.version,
      'scope_path', v_pricing.scope_path
    ) END,
    'cod_policy', CASE WHEN v_cod.settings_id IS NULL THEN NULL ELSE jsonb_build_object(
      'settings_id', v_cod.settings_id,
      'settings_version_id', v_cod.settings_version_id,
      'scope_type', v_cod.scope_type,
      'scope_id', v_cod.scope_id,
      'value', v_cod.value,
      'version', v_cod.version,
      'scope_path', v_cod.scope_path
    ) END,
    'settlement_policy', CASE WHEN v_settlement.settings_id IS NULL THEN NULL ELSE jsonb_build_object(
      'settings_id', v_settlement.settings_id,
      'settings_version_id', v_settlement.settings_version_id,
      'scope_type', v_settlement.scope_type,
      'scope_id', v_settlement.scope_id,
      'value', v_settlement.value,
      'version', v_settlement.version,
      'scope_path', v_settlement.scope_path
    ) END
  ));
END;
$function$;

COMMENT ON FUNCTION public.resolve_commercial_terms_v1(JSONB) IS
  'Resolve the effective commercial terms bundle (agreement-as-resolution) for a context: shipment_promise_policy, pricing_policy, cod_policy, settlement_policy.';

REVOKE ALL ON FUNCTION public.resolve_commercial_terms_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_commercial_terms_v1(JSONB) TO service_role;

COMMIT;

