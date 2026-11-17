-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S03,S04,S09
-- Migration: Integration plugin activation hardening + rollback RPC v1
-- Purpose:
--   - Add deterministic reactivation/rollback for plugin versions.
--   - Ensure only one active version remains enabled at a time.
--   - Reuse existing runtime artifacts when available (no duplicate materialization on rollback).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220080_integration_plugin_activation_rollback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Runtime binding/resource toggle helper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_set_binding_runtime_enabled_v1(
  p_plugin_version_id UUID,
  p_enabled BOOLEAN,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := lower(NULLIF(COALESCE(p_scope_type, ''), ''));
  v_binding RECORD;
  v_changed INTEGER := 0;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_set_binding_runtime_enabled_v1 requires plugin_version_id';
  END IF;

  FOR v_binding IN
    SELECT b.id, b.runtime_resource_type, b.runtime_resource_id
    FROM public.integration_plugin_bindings b
    WHERE b.plugin_version_id = p_plugin_version_id
      AND (
        v_scope_type IS NULL
        OR (
          lower(b.scope_type) = v_scope_type
          AND b.scope_id IS NOT DISTINCT FROM p_scope_id
        )
      )
  LOOP
    IF v_binding.runtime_resource_id IS NULL THEN
      CONTINUE;
    END IF;

    CASE lower(COALESCE(v_binding.runtime_resource_type, ''))
      WHEN 'webhook_sources' THEN
        UPDATE public.webhook_sources
        SET enabled = p_enabled,
            updated_at = now()
        WHERE id = v_binding.runtime_resource_id
          AND enabled IS DISTINCT FROM p_enabled;

      WHEN 'api_routes' THEN
        UPDATE public.api_routes
        SET enabled = p_enabled,
            updated_at = now()
        WHERE id = v_binding.runtime_resource_id
          AND enabled IS DISTINCT FROM p_enabled;

      WHEN 'api_route_packs' THEN
        UPDATE public.api_route_packs
        SET enabled = p_enabled,
            updated_at = now()
        WHERE id = v_binding.runtime_resource_id
          AND enabled IS DISTINCT FROM p_enabled;

      WHEN 'providers' THEN
        UPDATE public.providers
        SET enabled = p_enabled,
            updated_at = now()
        WHERE id = v_binding.runtime_resource_id
          AND enabled IS DISTINCT FROM p_enabled;

      ELSE
        -- Not all resource types expose an `enabled` flag.
        NULL;
    END CASE;
  END LOOP;

  UPDATE public.integration_plugin_bindings b
  SET enabled = p_enabled,
      updated_at = now()
  WHERE b.plugin_version_id = p_plugin_version_id
    AND (
      v_scope_type IS NULL
      OR (
        lower(b.scope_type) = v_scope_type
        AND b.scope_id IS NOT DISTINCT FROM p_scope_id
      )
    )
    AND b.enabled IS DISTINCT FROM p_enabled;

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$function$;

-------------------------------------------------------------------------------
-- 2) Preserve existing materialization function and wrap with hardened activation
-------------------------------------------------------------------------------

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'integration_plugin_activate_v1'
      AND pg_get_function_identity_arguments(p.oid) = 'uuid, text, uuid, text'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'integration_plugin_activate_core_v1'
      AND pg_get_function_identity_arguments(p.oid) = 'uuid, text, uuid, text'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.integration_plugin_activate_v1(UUID, TEXT, UUID, TEXT) RENAME TO integration_plugin_activate_core_v1';
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.integration_plugin_activate_v1(
  p_plugin_version_id UUID,
  p_scope_type TEXT DEFAULT 'tenant',
  p_scope_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_scope_type), ''), 'tenant'));
  v_scope_id UUID := p_scope_id;
  v_previous_active_version_id UUID;
  v_existing_scope_bindings INT := 0;
  v_activation_result JSONB;
  v_artifact_hash TEXT;
  v_workflow_template_name TEXT;
  v_source_id UUID;
  v_source_identifier TEXT;
  v_issued_token TEXT := NULL;
  v_route_id UUID;
  v_pack_id UUID;
  v_provider_id UUID;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 requires plugin_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_id IS NULL AND v_scope_type = 'tenant' THEN
    v_scope_id := v_plugin.organization_id;
  END IF;

  IF NOT public.integration_plugin_scope_belongs_org_v1(v_scope_type, v_scope_id, v_plugin.organization_id) THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 invalid scope %/% for organization %', v_scope_type, v_scope_id, v_plugin.organization_id;
  END IF;

  IF v_version.status NOT IN ('approved', 'active') THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 requires approved|active status (current=%)', v_version.status;
  END IF;

  v_workflow_template_name := public.integration_plugin_resolve_template_name_v1(COALESCE(v_version.workflow_binding, '{}'::jsonb));
  IF v_workflow_template_name IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 requires valid workflow binding before activation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE wt.name = v_workflow_template_name
      AND wt.status = 'active'
  ) THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 workflow template % missing/inactive', v_workflow_template_name;
  END IF;

  v_previous_active_version_id := v_plugin.active_version_id;
  IF v_previous_active_version_id IS NOT NULL AND v_previous_active_version_id <> v_version.id THEN
    PERFORM public.integration_plugin_set_binding_runtime_enabled_v1(v_previous_active_version_id, FALSE, NULL, NULL);

    UPDATE public.integration_plugin_versions
    SET status = 'approved',
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_previous_active_version_id
      AND status = 'active';
  END IF;

  SELECT count(*)
    INTO v_existing_scope_bindings
    FROM public.integration_plugin_bindings b
   WHERE b.plugin_version_id = v_version.id
     AND lower(b.scope_type) = v_scope_type
     AND b.scope_id IS NOT DISTINCT FROM v_scope_id;

  IF v_existing_scope_bindings > 0 THEN
    PERFORM public.integration_plugin_set_binding_runtime_enabled_v1(v_version.id, TRUE, v_scope_type, v_scope_id);

    SELECT b.runtime_resource_id
      INTO v_source_id
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = v_version.id
       AND lower(b.scope_type) = v_scope_type
       AND b.scope_id IS NOT DISTINCT FROM v_scope_id
       AND b.binding_type = 'webhook_source'
       AND b.runtime_resource_type = 'webhook_sources'
     ORDER BY b.created_at DESC
     LIMIT 1;

    IF v_source_id IS NOT NULL THEN
      SELECT ws.source_identifier
        INTO v_source_identifier
        FROM public.webhook_sources ws
       WHERE ws.id = v_source_id
       LIMIT 1;
    END IF;

    SELECT b.runtime_resource_id
      INTO v_route_id
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = v_version.id
       AND lower(b.scope_type) = v_scope_type
       AND b.scope_id IS NOT DISTINCT FROM v_scope_id
       AND b.binding_type = 'api_route'
       AND b.runtime_resource_type = 'api_routes'
     ORDER BY b.created_at DESC
     LIMIT 1;

    IF v_route_id IS NOT NULL THEN
      SELECT r.pack_id
        INTO v_pack_id
        FROM public.api_routes r
       WHERE r.id = v_route_id
       LIMIT 1;
    END IF;

    SELECT b.runtime_resource_id
      INTO v_provider_id
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = v_version.id
       AND lower(b.scope_type) = v_scope_type
       AND b.scope_id IS NOT DISTINCT FROM v_scope_id
       AND b.binding_type = 'provider'
       AND b.runtime_resource_type = 'providers'
     ORDER BY b.created_at DESC
     LIMIT 1;

    v_artifact_hash := COALESCE(
      v_version.artifact_hash,
      public.integration_plugin_hash_payload_v1(
        jsonb_build_object(
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id,
          'scope_type', v_scope_type,
          'scope_id', v_scope_id,
          'reactivated_existing_bindings', TRUE
        )
      )
    );

    UPDATE public.integration_plugin_versions
    SET status = 'active',
        activated_at = COALESCE(activated_at, now()),
        activated_by = COALESCE(activated_by, auth.uid()),
        artifact_hash = v_artifact_hash,
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_version.id;

    UPDATE public.integration_plugins
    SET status = 'active',
        active_version_id = v_version.id,
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_plugin.id;

    INSERT INTO public.integration_plugin_approval_events (
      plugin_version_id,
      organization_id,
      action,
      actor_user_id,
      reason,
      diff_hash,
      artifact_hash,
      payload
    )
    VALUES (
      v_version.id,
      v_plugin.organization_id,
      'activated',
      auth.uid(),
      NULLIF(btrim(COALESCE(p_reason, '')), ''),
      public.integration_plugin_hash_payload_v1(
        jsonb_build_object(
          'normalized_contract', v_version.normalized_contract,
          'inbound_config', v_version.inbound_config,
          'mapping_config', v_version.mapping_config,
          'workflow_binding', v_version.workflow_binding,
          'outbound_operations', v_version.outbound_operations
        )
      ),
      v_artifact_hash,
      jsonb_build_object(
        'scope_type', v_scope_type,
        'scope_id', v_scope_id,
        'reactivated_existing_bindings', TRUE,
        'webhook_source_id', v_source_id,
        'webhook_source_identifier', v_source_identifier,
        'api_route_id', v_route_id,
        'api_route_pack_id', v_pack_id,
        'provider_id', v_provider_id
      )
    );

    RETURN jsonb_build_object(
      'ok', TRUE,
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'status', 'active',
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'reactivated_existing_bindings', TRUE,
      'webhook_source_id', v_source_id,
      'webhook_source_identifier', v_source_identifier,
      'issued_token', v_issued_token,
      'api_route_id', v_route_id,
      'api_route_pack_id', v_pack_id,
      'provider_id', v_provider_id,
      'artifact_hash', v_artifact_hash
    );
  END IF;

  IF v_version.status = 'active' THEN
    UPDATE public.integration_plugin_versions
    SET status = 'approved',
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_version.id;
  END IF;

  SELECT public.integration_plugin_activate_core_v1(
    p_plugin_version_id := v_version.id,
    p_scope_type := v_scope_type,
    p_scope_id := v_scope_id,
    p_reason := p_reason
  )
  INTO v_activation_result;

  RETURN COALESCE(v_activation_result, '{}'::jsonb) || jsonb_build_object(
    'reactivated_existing_bindings', FALSE
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Rollback RPC (deterministic previous-version reactivation)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_rollback_v1(
  p_plugin_id UUID,
  p_target_plugin_version_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_plugin public.integration_plugins%ROWTYPE;
  v_current_version public.integration_plugin_versions%ROWTYPE;
  v_target_version public.integration_plugin_versions%ROWTYPE;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_result JSONB;
  v_reason TEXT;
BEGIN
  IF p_plugin_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rollback_v1 requires plugin_id';
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = p_plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rollback_v1 plugin % not found', p_plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  IF v_plugin.active_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rollback_v1 requires plugin.active_version_id';
  END IF;

  SELECT * INTO v_current_version
  FROM public.integration_plugin_versions
  WHERE id = v_plugin.active_version_id
  LIMIT 1;

  IF v_current_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rollback_v1 active version % not found', v_plugin.active_version_id;
  END IF;

  IF p_target_plugin_version_id IS NOT NULL THEN
    SELECT * INTO v_target_version
    FROM public.integration_plugin_versions
    WHERE id = p_target_plugin_version_id
      AND plugin_id = v_plugin.id
    LIMIT 1;
  ELSE
    SELECT * INTO v_target_version
    FROM public.integration_plugin_versions v
    WHERE v.plugin_id = v_plugin.id
      AND v.id <> v_current_version.id
      AND EXISTS (
        SELECT 1
        FROM public.integration_plugin_bindings b
        WHERE b.plugin_version_id = v.id
      )
    ORDER BY v.version_no DESC
    LIMIT 1;
  END IF;

  IF v_target_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rollback_v1 target version not found for plugin %', v_plugin.id;
  END IF;

  IF v_target_version.id = v_current_version.id THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'already_active', TRUE,
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_current_version.id
    );
  END IF;

  SELECT b.scope_type, b.scope_id
    INTO v_scope_type, v_scope_id
    FROM public.integration_plugin_bindings b
   WHERE b.plugin_version_id = v_target_version.id
   ORDER BY b.enabled DESC, b.created_at DESC
   LIMIT 1;

  IF v_scope_type IS NULL OR v_scope_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rollback_v1 target version % has no reusable bindings', v_target_version.id;
  END IF;

  IF v_target_version.status NOT IN ('approved', 'active') THEN
    UPDATE public.integration_plugin_versions
    SET status = 'approved',
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_target_version.id;
  END IF;

  v_reason := COALESCE(
    NULLIF(btrim(COALESCE(p_reason, '')), ''),
    format('Rollback plugin %s from v%s to v%s', v_plugin.plugin_key, v_current_version.version_no, v_target_version.version_no)
  );

  SELECT public.integration_plugin_activate_v1(
    p_plugin_version_id := v_target_version.id,
    p_scope_type := v_scope_type,
    p_scope_id := v_scope_id,
    p_reason := v_reason
  )
  INTO v_result;

  INSERT INTO public.integration_plugin_approval_events (
    plugin_version_id,
    organization_id,
    action,
    actor_user_id,
    reason,
    diff_hash,
    artifact_hash,
    payload
  )
  VALUES (
    v_target_version.id,
    v_plugin.organization_id,
    'rolled_back',
    auth.uid(),
    v_reason,
    public.integration_plugin_hash_payload_v1(
      jsonb_build_object(
        'from_version_id', v_current_version.id,
        'to_version_id', v_target_version.id,
        'from_version_no', v_current_version.version_no,
        'to_version_no', v_target_version.version_no
      )
    ),
    COALESCE(v_result->>'artifact_hash', v_target_version.artifact_hash),
    jsonb_build_object(
      'from_plugin_version_id', v_current_version.id,
      'to_plugin_version_id', v_target_version.id,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'activation_result', COALESCE(v_result, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'from_plugin_version_id', v_current_version.id,
    'to_plugin_version_id', v_target_version.id,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'activation', COALESCE(v_result, '{}'::jsonb)
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Grants + API wrapper
-------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.integration_plugin_set_binding_runtime_enabled_v1(UUID, BOOLEAN, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_activate_v1(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_rollback_v1(UUID, UUID, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.integration_plugin_set_binding_runtime_enabled_v1(UUID, BOOLEAN, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_activate_v1(UUID, TEXT, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_rollback_v1(UUID, UUID, TEXT) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.integration_plugin_rollback_v1(
  p_plugin_id UUID,
  p_target_plugin_version_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.integration_plugin_rollback_v1(
    p_plugin_id := p_plugin_id,
    p_target_plugin_version_id := p_target_plugin_version_id,
    p_reason := p_reason
  );
$function$;

REVOKE ALL ON FUNCTION api.integration_plugin_rollback_v1(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.integration_plugin_rollback_v1(UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION api.integration_plugin_rollback_v1(UUID, UUID, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602220080_integration_plugin_activation_rollback_v1'));
COMMIT;
