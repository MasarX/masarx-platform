-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S03,S95,S99
-- Migration: Integration plugin lifecycle lint/runtime fixes v1
-- Purpose:
--   - Fix validate RPC array append semantics to satisfy runtime + lint.
--   - Restore deterministic core activation function for wrapper delegation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220090_integration_plugin_lifecycle_lint_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.integration_plugin_validate_v1(
  p_plugin_version_id UUID,
  p_preview_payload JSONB DEFAULT '{}'::jsonb,
  p_allow_external_side_effects BOOLEAN DEFAULT FALSE
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
  v_policy JSONB;
  v_security_policy JSONB;
  v_allowed_auth_modes TEXT[] := ARRAY[]::TEXT[];
  v_template_name TEXT;
  v_errors TEXT[] := ARRAY[]::TEXT[];
  v_warnings TEXT[] := ARRAY[]::TEXT[];
  v_route JSONB;
  v_webhook JSONB;
  v_ops JSONB;
  v_op JSONB;
  v_auth_mode TEXT;
  v_idx INT := 0;
  v_run_id UUID;
  v_ok BOOLEAN;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_validate_v1 requires plugin_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_validate_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_validate_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.test', 'tenant', v_plugin.organization_id);

  v_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_policy', v_plugin.organization_id);
  v_security_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_security_policy', v_plugin.organization_id);

  SELECT COALESCE(array_agg(mode_value), ARRAY[]::TEXT[])
    INTO v_allowed_auth_modes
    FROM jsonb_array_elements_text(COALESCE(v_policy #> '{auth,allowed_modes}', '[]'::jsonb)) AS mode_value;

  v_template_name := public.integration_plugin_resolve_template_name_v1(COALESCE(v_version.workflow_binding, '{}'::jsonb));
  IF v_template_name IS NULL THEN
    v_errors := array_append(v_errors, 'workflow_binding requires template_name or valid template_id');
  END IF;

  IF v_template_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workflow_templates wt WHERE wt.name = v_template_name AND wt.status = 'active'
  ) THEN
    v_errors := array_append(v_errors, format('workflow template %s is not active or missing', v_template_name));
  END IF;

  IF lower(v_plugin.plugin_kind) = 'api' THEN
    v_route := COALESCE(v_version.inbound_config->'route', '{}'::jsonb);

    IF NULLIF(COALESCE(v_route->>'method', ''), '') IS NULL THEN
      v_errors := array_append(v_errors, 'api inbound_config.route.method is required');
    END IF;

    IF NULLIF(COALESCE(v_route->>'path_template', ''), '') IS NULL THEN
      v_errors := array_append(v_errors, 'api inbound_config.route.path_template is required');
    END IF;
  ELSIF lower(v_plugin.plugin_kind) = 'webhook' THEN
    v_webhook := COALESCE(v_version.inbound_config->'webhook', '{}'::jsonb);

    IF NULLIF(COALESCE(v_webhook->>'source_identifier', ''), '') IS NULL
       AND NULLIF(COALESCE(v_webhook->>'name', ''), '') IS NULL THEN
      v_warnings := array_append(v_warnings, 'webhook source identifier/name not provided; activation will generate one');
    END IF;
  ELSE
    v_errors := array_append(v_errors, format('unsupported plugin_kind=%s', v_plugin.plugin_kind));
  END IF;

  IF jsonb_typeof(COALESCE(v_version.outbound_operations, '[]'::jsonb)) <> 'array' THEN
    v_errors := array_append(v_errors, 'outbound_operations must be an array');
  ELSE
    v_ops := COALESCE(v_version.outbound_operations, '[]'::jsonb);

    FOR v_op IN
      SELECT value
      FROM jsonb_array_elements(v_ops)
    LOOP
      v_idx := v_idx + 1;

      IF jsonb_typeof(v_op) <> 'object' THEN
        v_errors := array_append(v_errors, format('outbound_operations[%s] must be an object', v_idx));
        CONTINUE;
      END IF;

      IF NULLIF(COALESCE(v_op->>'operation_name', ''), '') IS NULL THEN
        v_errors := array_append(v_errors, format('outbound_operations[%s].operation_name is required', v_idx));
      END IF;

      IF NULLIF(COALESCE(v_op->>'method', ''), '') IS NULL THEN
        v_errors := array_append(v_errors, format('outbound_operations[%s].method is required', v_idx));
      END IF;

      IF NULLIF(COALESCE(v_op->>'url_template', ''), '') IS NULL THEN
        v_errors := array_append(v_errors, format('outbound_operations[%s].url_template is required', v_idx));
      END IF;

      IF NULLIF(COALESCE(v_op->>'url_template', ''), '') IS NOT NULL
         AND lower(v_op->>'url_template') !~ '^https://'
      THEN
        v_errors := array_append(v_errors, format('outbound_operations[%s].url_template must use https://', v_idx));
      END IF;

      v_auth_mode := NULLIF(COALESCE(v_op #>> '{auth,mode}', ''), '');
      IF v_auth_mode IS NOT NULL AND array_length(v_allowed_auth_modes, 1) IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1
          FROM unnest(v_allowed_auth_modes) AS value
          WHERE lower(value) = lower(v_auth_mode)
        ) THEN
          v_errors := array_append(v_errors, format('outbound_operations[%s].auth.mode=%s is not allowed by policy', v_idx, v_auth_mode));
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF p_allow_external_side_effects AND COALESCE((v_security_policy #>> '{preview,allow_external_side_effects}')::BOOLEAN, FALSE) = FALSE THEN
    v_errors := array_append(v_errors, 'preview side effects are blocked by integration_plugin_security_policy.preview.allow_external_side_effects=false');
  END IF;

  v_ok := COALESCE(array_length(v_errors, 1), 0) = 0;

  INSERT INTO public.integration_plugin_validation_runs (
    plugin_version_id,
    organization_id,
    run_type,
    status,
    sandbox_mode,
    request_payload,
    result_payload,
    executed_by,
    evidence_hash,
    completed_at,
    error_message
  )
  VALUES (
    v_version.id,
    v_plugin.organization_id,
    'validate',
    CASE WHEN v_ok THEN 'succeeded' ELSE 'failed' END,
    NOT p_allow_external_side_effects,
    jsonb_build_object(
      'preview_payload', COALESCE(p_preview_payload, '{}'::jsonb),
      'allow_external_side_effects', p_allow_external_side_effects
    ),
    jsonb_build_object(
      'ok', v_ok,
      'errors', to_jsonb(COALESCE(v_errors, ARRAY[]::TEXT[])),
      'warnings', to_jsonb(COALESCE(v_warnings, ARRAY[]::TEXT[])),
      'workflow_template_name', v_template_name
    ),
    auth.uid(),
    public.integration_plugin_hash_payload_v1(
      jsonb_build_object(
        'plugin_version_id', v_version.id,
        'errors', to_jsonb(COALESCE(v_errors, ARRAY[]::TEXT[])),
        'warnings', to_jsonb(COALESCE(v_warnings, ARRAY[]::TEXT[]))
      )
    ),
    now(),
    CASE WHEN v_ok THEN NULL ELSE array_to_string(v_errors, '; ') END
  )
  RETURNING id INTO v_run_id;

  UPDATE public.integration_plugin_versions
     SET validation_summary = jsonb_build_object(
           'ok', v_ok,
           'errors', to_jsonb(COALESCE(v_errors, ARRAY[]::TEXT[])),
           'warnings', to_jsonb(COALESCE(v_warnings, ARRAY[]::TEXT[])),
           'validated_at', now(),
           'validation_run_id', v_run_id
         ),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_version.id;

  RETURN jsonb_build_object(
    'ok', v_ok,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'validation_run_id', v_run_id,
    'errors', to_jsonb(COALESCE(v_errors, ARRAY[]::TEXT[])),
    'warnings', to_jsonb(COALESCE(v_warnings, ARRAY[]::TEXT[])),
    'workflow_template_name', v_template_name
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_activate_core_v1(
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
  v_workflow_template_name TEXT;
  v_workflow_template_id UUID;

  v_source_mapping_id UUID;
  v_source_id UUID;
  v_source_identifier TEXT;
  v_source_name TEXT;
  v_source_token TEXT;
  v_source_suffix INT := 1;

  v_provider_id UUID := NULL;
  v_pack_id UUID := NULL;
  v_route_id UUID := NULL;
  v_pack_name TEXT;
  v_pack_suffix INT := 1;

  v_route_policy JSONB;
  v_method TEXT;
  v_path_template TEXT;
  v_upstream_method TEXT;
  v_upstream_path_template TEXT;

  v_binding_payload JSONB;
  v_webhook_policy JSONB;
  v_artifact_hash TEXT;

  v_op JSONB;
  v_op_name TEXT;
  v_op_method TEXT;
  v_op_url TEXT;
  v_op_headers JSONB;
  v_op_body JSONB;
  v_op_mappings JSONB;
  v_op_timeout INT;
  v_op_mapping_id UUID;
  v_op_template_id UUID;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 requires plugin_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  IF v_version.status = 'active' AND v_plugin.active_version_id = v_version.id THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'already_active', TRUE,
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id
    );
  END IF;

  IF v_version.status <> 'approved' THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 requires approved status (current=%)', v_version.status;
  END IF;

  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_id IS NULL AND v_scope_type = 'tenant' THEN
    v_scope_id := v_plugin.organization_id;
  END IF;

  IF NOT public.integration_plugin_scope_belongs_org_v1(v_scope_type, v_scope_id, v_plugin.organization_id) THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 invalid scope %/% for organization %', v_scope_type, v_scope_id, v_plugin.organization_id;
  END IF;

  v_workflow_template_name := public.integration_plugin_resolve_template_name_v1(COALESCE(v_version.workflow_binding, '{}'::jsonb));

  IF v_workflow_template_name IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 requires valid workflow binding before activation';
  END IF;

  SELECT wt.id
    INTO v_workflow_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = v_workflow_template_name
     AND wt.status = 'active'
   ORDER BY wt.updated_at DESC
   LIMIT 1;

  IF v_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 workflow template % missing/inactive', v_workflow_template_name;
  END IF;

  INSERT INTO public.mapping_configs (
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes,
    organization_id,
    managed_by,
    managed_metadata
  )
  VALUES (
    'webhook_inbound',
    format('integration_plugin:%s:source:%s:%s', v_version.id, v_scope_type, v_scope_id),
    COALESCE(v_version.mapping_config, '{}'::jsonb),
    1,
    'integration plugin source mapping',
    v_plugin.organization_id,
    'integration_plugin',
    jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id)
  )
  ON CONFLICT (mapping_type, mapping_key)
  DO UPDATE SET
    mapping_config = EXCLUDED.mapping_config,
    organization_id = EXCLUDED.organization_id,
    managed_by = EXCLUDED.managed_by,
    managed_metadata = EXCLUDED.managed_metadata,
    updated_at = now()
  RETURNING id INTO v_source_mapping_id;

  v_source_identifier := format(
    'ip-%s-%s',
    left(replace(v_plugin.id::text, '-', ''), 10),
    left(replace(v_version.id::text, '-', ''), 10)
  );

  WHILE EXISTS (SELECT 1 FROM public.webhook_sources ws WHERE ws.source_identifier = v_source_identifier) LOOP
    v_source_suffix := v_source_suffix + 1;
    v_source_identifier := format(
      'ip-%s-%s-%s',
      left(replace(v_plugin.id::text, '-', ''), 8),
      left(replace(v_version.id::text, '-', ''), 8),
      v_source_suffix
    );
  END LOOP;

  v_source_name := format('%s integration source', v_plugin.name);
  v_source_token := 'ipt_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.webhook_sources (
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    sender_id,
    enabled,
    managed_by,
    managed_metadata
  )
  VALUES (
      v_plugin.organization_id,
      v_source_identifier,
      left(v_source_name, 200),
      'generic',
      v_source_token,
      v_source_mapping_id,
      CASE WHEN v_scope_type = 'sender' THEN v_scope_id ELSE NULL END,
    TRUE,
    'integration_plugin',
    jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id)
  )
  RETURNING id INTO v_source_id;

  v_binding_payload := jsonb_build_object(
    'source_identifier', v_source_identifier,
    'issued_token', v_source_token
  );

  INSERT INTO public.integration_plugin_bindings (
    plugin_version_id,
    organization_id,
    scope_type,
    scope_id,
    binding_type,
    runtime_resource_type,
    runtime_resource_id,
    enabled,
    activation_payload,
    metadata,
    created_by
  )
  VALUES (
    v_version.id,
    v_plugin.organization_id,
    v_scope_type,
    v_scope_id,
    'webhook_source',
    'webhook_sources',
    v_source_id,
    TRUE,
    v_binding_payload,
    jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id),
    auth.uid()
  );

  IF lower(v_plugin.plugin_kind) = 'webhook' THEN
    v_webhook_policy := jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object(
        'mode', 'accepted_async',
        'status_code', 202,
        'default_headers', jsonb_build_object('content-type', 'application/json')
      ),
      'workflow', jsonb_build_object(
        'template_id', v_workflow_template_id,
        'intent', 'integration_plugin',
        'notes', format('plugin_id=%s plugin_version_id=%s', v_plugin.id, v_version.id)
      )
    );

    PERFORM public.upsert_webhook_ingest_policy('source', v_source_id, v_webhook_policy);
  ELSE
    SELECT p.id
      INTO v_provider_id
      FROM public.providers p
     WHERE p.organization_id = v_plugin.organization_id
       AND p.metadata->>'plugin_version_id' = v_version.id::text
     ORDER BY p.updated_at DESC
     LIMIT 1;

    IF v_provider_id IS NULL THEN
      INSERT INTO public.providers (
        organization_id,
        name,
        provider_type,
        enabled,
        priority_rank,
        health_status,
        metadata
      )
      VALUES (
        v_plugin.organization_id,
        format('integration_plugin_%s_v%s', v_plugin.plugin_key, v_version.version_no),
        'webhook',
        TRUE,
        100,
        'healthy',
        jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id
        )
      )
      RETURNING id INTO v_provider_id;
    END IF;

    v_pack_name := format(
      'ip-%s-v%s-%s',
      v_plugin.plugin_key,
      v_version.version_no,
      left(replace(v_scope_id::text, '-', ''), 8)
    );

    WHILE EXISTS (SELECT 1 FROM public.api_route_packs p WHERE p.name = v_pack_name) LOOP
      v_pack_suffix := v_pack_suffix + 1;
      v_pack_name := left(
        format('ip-%s-v%s-%s-%s', v_plugin.plugin_key, v_version.version_no, left(replace(v_scope_id::text, '-', ''), 6), v_pack_suffix),
        120
      );
    END LOOP;

    INSERT INTO public.api_route_packs (
      name,
      description,
      enabled,
      scope_type,
      scope_id,
      managed_by,
      managed_metadata
    )
    VALUES (
      v_pack_name,
      format('Integration plugin pack: %s (version %s)', v_plugin.name, v_version.version_no),
      TRUE,
      v_scope_type,
      v_scope_id,
      'integration_plugin',
      jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id)
    )
    RETURNING id INTO v_pack_id;

    v_method := upper(COALESCE(NULLIF(v_version.inbound_config #>> '{route,method}', ''), 'POST'));
    v_path_template := COALESCE(
      NULLIF(v_version.inbound_config #>> '{route,path_template}', ''),
      format('/plugins/%s', v_plugin.plugin_key)
    );
    v_upstream_method := upper(COALESCE(NULLIF(v_version.inbound_config #>> '{route,upstream_method}', ''), v_method));
    v_upstream_path_template := COALESCE(
      NULLIF(v_version.inbound_config #>> '{route,upstream_path_template}', ''),
      v_path_template
    );

    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,enabled}', 'true'::jsonb, TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,template_name}', to_jsonb(v_workflow_template_name), TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery,mode}', '"accepted_async"'::jsonb, TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery,status_code}', '202'::jsonb, TRUE);

    INSERT INTO public.api_routes (
      pack_id,
      route_name,
      enabled,
      method,
      path_template,
      scope_type,
      scope_id,
      provider_id,
      upstream_method,
      upstream_path_template,
      policy,
      managed_by,
      managed_metadata
    )
    VALUES (
      v_pack_id,
      format('integration_plugin_%s_v%s', v_plugin.plugin_key, v_version.version_no),
      TRUE,
      v_method,
      v_path_template,
      v_scope_type,
      v_scope_id,
      v_provider_id,
      v_upstream_method,
      v_upstream_path_template,
      v_route_policy,
      'integration_plugin',
      jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id)
    )
    RETURNING id INTO v_route_id;

    INSERT INTO public.integration_plugin_bindings (
      plugin_version_id,
      organization_id,
      scope_type,
      scope_id,
      binding_type,
      runtime_resource_type,
      runtime_resource_id,
      enabled,
      activation_payload,
      metadata,
      created_by
    )
    VALUES
      (
        v_version.id,
        v_plugin.organization_id,
        v_scope_type,
        v_scope_id,
        'api_route',
        'api_routes',
        v_route_id,
        TRUE,
        jsonb_build_object('pack_id', v_pack_id, 'path_template', v_path_template, 'method', v_method),
        jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id),
        auth.uid()
      ),
      (
        v_version.id,
        v_plugin.organization_id,
        v_scope_type,
        v_scope_id,
        'provider',
        'providers',
        v_provider_id,
        TRUE,
        jsonb_build_object('provider_id', v_provider_id),
        jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id),
        auth.uid()
      );
  END IF;

  IF jsonb_typeof(COALESCE(v_version.outbound_operations, '[]'::jsonb)) = 'array'
     AND jsonb_array_length(COALESCE(v_version.outbound_operations, '[]'::jsonb)) > 0 THEN

    IF v_provider_id IS NULL THEN
      INSERT INTO public.providers (
        organization_id,
        name,
        provider_type,
        enabled,
        priority_rank,
        health_status,
        metadata
      )
      VALUES (
        v_plugin.organization_id,
        format('integration_plugin_%s_v%s_ops', v_plugin.plugin_key, v_version.version_no),
        'webhook',
        TRUE,
        100,
        'healthy',
        jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id
        )
      )
      RETURNING id INTO v_provider_id;

      INSERT INTO public.integration_plugin_bindings (
        plugin_version_id,
        organization_id,
        scope_type,
        scope_id,
        binding_type,
        runtime_resource_type,
        runtime_resource_id,
        enabled,
        activation_payload,
        metadata,
        created_by
      )
      VALUES (
        v_version.id,
        v_plugin.organization_id,
        v_scope_type,
        v_scope_id,
        'provider',
        'providers',
        v_provider_id,
        TRUE,
        jsonb_build_object('provider_id', v_provider_id),
        jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id),
        auth.uid()
      );
    END IF;

    FOR v_op IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_version.outbound_operations, '[]'::jsonb))
    LOOP
      v_op_name := NULLIF(COALESCE(v_op->>'operation_name', ''), '');
      v_op_method := upper(COALESCE(NULLIF(v_op->>'method', ''), 'POST'));
      v_op_url := NULLIF(COALESCE(v_op->>'url_template', ''), '');
      v_op_headers := COALESCE(v_op->'headers_template', '{}'::jsonb);
      v_op_body := COALESCE(v_op->'body_template', '{}'::jsonb);
      v_op_mappings := COALESCE(v_op->'request_mappings', '{}'::jsonb);
      v_op_timeout := COALESCE(NULLIF(v_op->>'timeout_seconds', '')::INT, 30);

      IF v_op_name IS NULL OR v_op_url IS NULL THEN
        CONTINUE;
      END IF;

      INSERT INTO public.mapping_configs (
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes,
        organization_id,
        managed_by,
        managed_metadata
      )
      VALUES (
        'provider_response',
        format('integration_plugin:%s:%s', v_version.id, v_op_name),
        COALESCE(v_op->'response_mapping', '{}'::jsonb),
        1,
        format('integration plugin operation mapping: %s', v_op_name),
        v_plugin.organization_id,
        'integration_plugin',
        jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id, 'operation_name', v_op_name)
      )
      ON CONFLICT (mapping_type, mapping_key)
      DO UPDATE SET
        mapping_config = EXCLUDED.mapping_config,
        organization_id = EXCLUDED.organization_id,
        managed_by = EXCLUDED.managed_by,
        managed_metadata = EXCLUDED.managed_metadata,
        updated_at = now()
      RETURNING id INTO v_op_mapping_id;

      INSERT INTO public.operation_templates (
        provider_id,
        operation_name,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        timeout_seconds,
        call_type,
        metadata
      )
      VALUES (
        v_provider_id,
        v_op_name,
        v_op_method,
        v_op_url,
        v_op_headers,
        v_op_body,
        v_op_mappings,
        v_op_mapping_id,
        GREATEST(v_op_timeout, 1),
        'provider_api',
        jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id,
          'auth', COALESCE(v_op->'auth', '{}'::jsonb)
        )
      )
      ON CONFLICT (provider_id, operation_name)
      DO UPDATE SET
        method = EXCLUDED.method,
        url_template = EXCLUDED.url_template,
        headers_template = EXCLUDED.headers_template,
        body_template = EXCLUDED.body_template,
        request_mappings = EXCLUDED.request_mappings,
        mapping_config_id = EXCLUDED.mapping_config_id,
        timeout_seconds = EXCLUDED.timeout_seconds,
        call_type = EXCLUDED.call_type,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id INTO v_op_template_id;

      INSERT INTO public.integration_plugin_bindings (
        plugin_version_id,
        organization_id,
        scope_type,
        scope_id,
        binding_type,
        runtime_resource_type,
        runtime_resource_id,
        enabled,
        activation_payload,
        metadata,
        created_by
      )
      VALUES (
        v_version.id,
        v_plugin.organization_id,
        v_scope_type,
        v_scope_id,
        'operation_template',
        'operation_templates',
        v_op_template_id,
        TRUE,
        jsonb_build_object('operation_name', v_op_name),
        jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id),
        auth.uid()
      )
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  v_artifact_hash := public.integration_plugin_hash_payload_v1(
    jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'workflow_template_name', v_workflow_template_name,
      'source_id', v_source_id,
      'route_id', v_route_id,
      'provider_id', v_provider_id,
      'outbound_operations', v_version.outbound_operations
    )
  );

  UPDATE public.integration_plugin_versions
     SET status = 'active',
         activated_at = now(),
         activated_by = auth.uid(),
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
      'source_id', v_source_id,
      'source_identifier', v_source_identifier,
      'route_id', v_route_id,
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
    'webhook_source_id', v_source_id,
    'webhook_source_identifier', v_source_identifier,
    'issued_token', v_source_token,
    'api_route_id', v_route_id,
    'api_route_pack_id', v_pack_id,
    'provider_id', v_provider_id,
    'artifact_hash', v_artifact_hash
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.integration_plugin_activate_core_v1(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.integration_plugin_activate_core_v1(UUID, TEXT, UUID, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202602220090_integration_plugin_lifecycle_lint_fix_v1'));
COMMIT;
