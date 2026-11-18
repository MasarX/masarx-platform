-- Migration: Pin outbound runtime handlers and preserve owned plugin materialization.
-- Keep activation inputs, policy parents, historical resources, privileges and hashes unchanged.
-- The prior operation seam includes the canonical handler added by 20261020050000.
BEGIN;
SET LOCAL lock_timeout = '30s';
DO $outbound_materialization$
DECLARE
 fn regprocedure := 'public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure;
 body TEXT;
 i INTEGER;
 priors TEXT[] := ARRAY[
$prior1$  ON CONFLICT (mapping_type, mapping_key)
  DO UPDATE SET
    mapping_config = EXCLUDED.mapping_config,
    organization_id = EXCLUDED.organization_id,
    managed_by = EXCLUDED.managed_by,
    managed_metadata = EXCLUDED.managed_metadata,
    updated_at = now()
  RETURNING id INTO v_source_mapping_id;$prior1$,
$prior2$    SELECT p.id
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
    END IF;$prior2$,
$prior3$    IF v_provider_id IS NULL THEN
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
    END IF;$prior3$,
$prior4$      ON CONFLICT (mapping_type, mapping_key)
      DO UPDATE SET
        mapping_config = EXCLUDED.mapping_config,
        organization_id = EXCLUDED.organization_id,
        managed_by = EXCLUDED.managed_by,
        managed_metadata = EXCLUDED.managed_metadata,
        updated_at = now()
      RETURNING id INTO v_op_mapping_id;$prior4$,
$prior5$      INSERT INTO public.operation_templates (
        provider_id,
        operation_name,
        handler_key,
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
        'outbound_http',
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
        handler_key = EXCLUDED.handler_key,
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
      RETURNING id INTO v_op_template_id;$prior5$
 ];
 replacements TEXT[] := ARRAY[
$replacement1$  ON CONFLICT (mapping_type, mapping_key)
  DO UPDATE SET
    mapping_config = EXCLUDED.mapping_config,
    organization_id = EXCLUDED.organization_id,
    managed_by = EXCLUDED.managed_by,
    managed_metadata = EXCLUDED.managed_metadata,
    updated_at = now()
  WHERE mapping_configs.organization_id = v_plugin.organization_id
    AND mapping_configs.managed_by = 'integration_plugin'
    AND mapping_configs.managed_metadata->>'plugin_id' = v_plugin.id::text
    AND mapping_configs.managed_metadata->>'plugin_version_id' = v_version.id::text
  RETURNING id INTO v_source_mapping_id;
  IF v_source_mapping_id IS NULL THEN
    RAISE EXCEPTION 'Integration plugin source mapping is not owned by this version' USING ERRCODE = '23514';
  END IF;$replacement1$,
$replacement2$    INSERT INTO public.providers (
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
    ON CONFLICT (organization_id, name) DO NOTHING;

    SELECT p.id INTO v_provider_id
    FROM public.providers p
    WHERE p.organization_id = v_plugin.organization_id
      AND p.name = format('integration_plugin_%s_v%s', v_plugin.plugin_key, v_version.version_no)
      AND p.provider_type = 'webhook'
      AND p.metadata->>'managed_by' = 'integration_plugin'
      AND p.metadata->>'plugin_id' = v_plugin.id::text
      AND p.metadata->>'plugin_version_id' = v_version.id::text
    LIMIT 1;
    IF v_provider_id IS NULL THEN
      RAISE EXCEPTION 'Integration plugin provider is not owned by this version' USING ERRCODE = '23514';
    END IF;$replacement2$,
$replacement3$    IF v_provider_id IS NULL THEN
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
      ON CONFLICT (organization_id, name) DO NOTHING;

      SELECT p.id INTO v_provider_id
      FROM public.providers p
      WHERE p.organization_id = v_plugin.organization_id
        AND p.name = format('integration_plugin_%s_v%s_ops', v_plugin.plugin_key, v_version.version_no)
        AND p.provider_type = 'webhook'
        AND p.metadata->>'managed_by' = 'integration_plugin'
        AND p.metadata->>'plugin_id' = v_plugin.id::text
        AND p.metadata->>'plugin_version_id' = v_version.id::text
      LIMIT 1;
      IF v_provider_id IS NULL THEN
        RAISE EXCEPTION 'Integration plugin provider is not owned by this version' USING ERRCODE = '23514';
      END IF;

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
      )
      ON CONFLICT DO NOTHING;
    END IF;$replacement3$,
$replacement4$      ON CONFLICT (mapping_type, mapping_key)
      DO UPDATE SET
        mapping_config = EXCLUDED.mapping_config,
        organization_id = EXCLUDED.organization_id,
        managed_by = EXCLUDED.managed_by,
        managed_metadata = EXCLUDED.managed_metadata,
        updated_at = now()
      WHERE mapping_configs.organization_id = v_plugin.organization_id
        AND mapping_configs.managed_by = 'integration_plugin'
        AND mapping_configs.managed_metadata->>'plugin_id' = v_plugin.id::text
        AND mapping_configs.managed_metadata->>'plugin_version_id' = v_version.id::text
      RETURNING id INTO v_op_mapping_id;
      IF v_op_mapping_id IS NULL THEN
        RAISE EXCEPTION 'Integration plugin response mapping is not owned by this version' USING ERRCODE = '23514';
      END IF;$replacement4$,
$replacement5$      INSERT INTO public.operation_templates (
        provider_id,
        operation_name,
        handler_key,
        handler_version,
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
        'outbound_http',
        'v1',
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
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
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
      WHERE operation_templates.provider_id = v_provider_id
        AND operation_templates.metadata->>'managed_by' = 'integration_plugin'
        AND operation_templates.metadata->>'plugin_id' = v_plugin.id::text
        AND operation_templates.metadata->>'plugin_version_id' = v_version.id::text
      RETURNING id INTO v_op_template_id;
      IF v_op_template_id IS NULL THEN
        RAISE EXCEPTION 'Integration plugin operation template is not owned by this version' USING ERRCODE = '23514';
      END IF;$replacement5$
 ];
BEGIN
 body:=pg_get_functiondef(fn);
 FOR i IN 1..array_length(priors,1) LOOP
  IF (length(body)-length(replace(body,priors[i],'')))/length(priors[i])<>1 THEN
   RAISE EXCEPTION 'Expected one unmodified integration plugin outbound materialization seam %',i;
  END IF;
  body:=replace(body,priors[i],replacements[i]);
 END LOOP;
 EXECUTE body;
END;
$outbound_materialization$;
COMMIT;
