-- use a null-safe caller-organization guard
BEGIN;

CREATE OR REPLACE FUNCTION public.integration_plugin_generate_draft_v1(
  p_plugin_name text,
  p_plugin_kind text,
  p_source_type text DEFAULT 'manual'::text,
  p_source_payload jsonb DEFAULT '{}'::jsonb,
  p_inbound_config jsonb DEFAULT '{}'::jsonb,
  p_mapping_config jsonb DEFAULT '{}'::jsonb,
  p_workflow_binding jsonb DEFAULT '{}'::jsonb,
  p_outbound_operations jsonb DEFAULT '[]'::jsonb,
  p_plugin_id uuid DEFAULT NULL::uuid,
  p_plugin_key text DEFAULT NULL::text,
  p_description text DEFAULT NULL::text,
  p_organization_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_org_id UUID;
  v_plugin public.integration_plugins%ROWTYPE;
  v_plugin_id UUID;
  v_plugin_key TEXT;
  v_version_no INTEGER;
  v_version_id UUID;
  v_counter INT := 1;
  v_kind TEXT := lower(COALESCE(NULLIF(btrim(p_plugin_kind), ''), ''));
  v_workflow_binding JSONB := COALESCE(p_workflow_binding, '{}'::jsonb);
  v_metadata JSONB := COALESCE(p_metadata, '{}'::jsonb) - 'normalized_contract';
  v_normalized_contract JSONB := COALESCE(
    NULLIF(COALESCE(p_metadata, '{}'::jsonb)->'normalized_contract', 'null'::jsonb),
    COALESCE(p_source_payload, '{}'::jsonb)
  );
BEGIN
  IF p_plugin_id IS NOT NULL THEN
    SELECT *
      INTO v_plugin
      FROM public.integration_plugins p
     WHERE p.id = p_plugin_id
     LIMIT 1;
  END IF;

  v_org_id := COALESCE(p_organization_id, v_plugin.organization_id, public.current_user_org_id());

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires tenant organization context';
  END IF;

  IF v_is_service IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND (
       (p_organization_id IS NOT NULL AND public.current_user_org_id() IS DISTINCT FROM p_organization_id)
       OR (v_plugin.id IS NOT NULL AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id)
     ) THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 cannot create drafts for another organization';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write', 'tenant', v_org_id);

  IF v_kind = '' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires plugin_kind';
  END IF;

  IF p_plugin_name IS NULL OR btrim(p_plugin_name) = '' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires plugin_name';
  END IF;

  IF jsonb_typeof(v_workflow_binding) <> 'object' OR v_workflow_binding = '{}'::jsonb THEN
    v_workflow_binding := public.integration_plugin_default_workflow_binding_v1(v_kind, v_org_id);
  END IF;

  IF p_plugin_id IS NOT NULL THEN
    IF v_plugin.id IS NULL THEN
      RAISE EXCEPTION 'integration_plugin_generate_draft_v1 plugin % not found', p_plugin_id;
    END IF;

    IF v_plugin.organization_id <> v_org_id THEN
      RAISE EXCEPTION 'integration_plugin_generate_draft_v1 organization mismatch for plugin %', p_plugin_id;
    END IF;

    v_plugin_id := v_plugin.id;
  ELSE
    v_plugin_key := public.integration_plugin_normalize_key_v1(COALESCE(NULLIF(btrim(p_plugin_key), ''), p_plugin_name));

    WHILE EXISTS (
      SELECT 1
      FROM public.integration_plugins p
      WHERE p.organization_id = v_org_id
        AND p.plugin_key = v_plugin_key
    ) LOOP
      v_counter := v_counter + 1;
      v_plugin_key := left(
        format('%s-%s', public.integration_plugin_normalize_key_v1(COALESCE(NULLIF(btrim(p_plugin_key), ''), p_plugin_name)), v_counter),
        80
      );
    END LOOP;

    INSERT INTO public.integration_plugins (
      organization_id,
      plugin_key,
      name,
      description,
      plugin_kind,
      status,
      managed_by,
      metadata,
      created_by,
      updated_by
    )
    VALUES (
      v_org_id,
      v_plugin_key,
      btrim(p_plugin_name),
      NULLIF(btrim(COALESCE(p_description, '')), ''),
      v_kind,
      'draft',
      'integration_plugin',
      v_metadata,
      auth.uid(),
      auth.uid()
    )
    RETURNING id INTO v_plugin_id;
  END IF;

  v_version_no := public.integration_plugin_next_version_no_v1(v_plugin_id);

  INSERT INTO public.integration_plugin_versions (
    plugin_id,
    organization_id,
    version_no,
    status,
    source_type,
    source_payload,
    normalized_contract,
    inbound_config,
    mapping_config,
    workflow_binding,
    outbound_operations,
    auth_bindings,
    metadata,
    created_by,
    updated_by
  )
  VALUES (
    v_plugin_id,
    v_org_id,
    v_version_no,
    'draft',
    lower(COALESCE(NULLIF(btrim(p_source_type), ''), 'manual')),
    COALESCE(p_source_payload, '{}'::jsonb),
    v_normalized_contract,
    COALESCE(p_inbound_config, '{}'::jsonb),
    COALESCE(p_mapping_config, '{}'::jsonb),
    COALESCE(v_workflow_binding, '{}'::jsonb),
    COALESCE(p_outbound_operations, '[]'::jsonb),
    '{}'::jsonb,
    jsonb_set(
      v_metadata,
      '{workflow_binding_source}',
      to_jsonb(CASE WHEN COALESCE(p_workflow_binding, '{}'::jsonb) = '{}'::jsonb THEN 'policy_default' ELSE 'request' END),
      TRUE
    ),
    auth.uid(),
    auth.uid()
  )
  RETURNING id INTO v_version_id;

  UPDATE public.integration_plugins
     SET status = 'draft',
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_plugin_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin_id,
    'version_id', v_version_id,
    'plugin_version_id', v_version_id,
    'version_no', v_version_no,
    'organization_id', v_org_id,
    'workflow_binding', COALESCE(v_workflow_binding, '{}'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.plugin_deactivate_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_user_id uuid := auth.uid();
  v_correlation_id uuid := gen_random_uuid();
  v_settings_resolution_id uuid := gen_random_uuid();
  v_plugin_id uuid;
  v_requested_version_id uuid;
  v_active_version_id uuid;
  v_plugin public.integration_plugins%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_changed integer := 0;
  v_binding_count integer := 0;
  v_reason text;
  v_artifact_hash text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 requires p_args object'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_plugin_id := COALESCE(
      NULLIF(v_args->>'plugin_id', ''),
      NULLIF(v_args->>'integration_plugin_id', '')
    )::uuid;
  EXCEPTION WHEN others THEN
    v_plugin_id := NULL;
  END;

  IF v_plugin_id IS NULL THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 requires plugin_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN
    v_requested_version_id := COALESCE(
      NULLIF(v_args->>'plugin_version_id', ''),
      NULLIF(v_args->>'integration_plugin_version_id', ''),
      NULLIF(v_args->>'active_version_id', '')
    )::uuid;
  EXCEPTION WHEN others THEN
    v_requested_version_id := NULL;
  END;

  v_reason := NULLIF(btrim(COALESCE(v_args->>'reason', '')), '');

  SELECT *
    INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_plugin_id
   FOR UPDATE;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 plugin % not found', v_plugin_id
      USING ERRCODE = '23503';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.activate' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  v_active_version_id := v_plugin.active_version_id;
  IF v_active_version_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'already_processed', TRUE,
      'plugin_id', v_plugin.id,
      'integration_plugin_id', v_plugin.id,
      'status', v_plugin.status,
      'changed_count', 0,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_settings_resolution_id
    );
  END IF;

  IF v_requested_version_id IS NOT NULL AND v_requested_version_id <> v_active_version_id THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 version % is not active for plugin %', v_requested_version_id, v_plugin.id
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_version
    FROM public.integration_plugin_versions
   WHERE id = v_active_version_id
     AND plugin_id = v_plugin.id
   FOR UPDATE;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 active version % not found for plugin %', v_active_version_id, v_plugin.id
      USING ERRCODE = '23503';
  END IF;

  SELECT count(*)::integer
    INTO v_binding_count
    FROM public.integration_plugin_bindings
   WHERE plugin_version_id = v_version.id;

  v_changed := public.integration_plugin_set_binding_runtime_enabled_v1(v_version.id, FALSE, NULL, NULL);

  v_artifact_hash := COALESCE(
    v_version.artifact_hash,
    public.integration_plugin_hash_payload_v1(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id
    ))
  );

  UPDATE public.integration_plugin_versions
     SET status = CASE WHEN status = 'active' THEN 'approved' ELSE status END,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{deactivation}',
           jsonb_strip_nulls(jsonb_build_object(
             'deactivated_at', now(),
             'deactivated_by', v_user_id,
             'reason', v_reason,
             'changed_count', v_changed,
             'binding_count', v_binding_count
           )),
           TRUE
         ),
         updated_by = v_user_id,
         updated_at = now()
   WHERE id = v_version.id;

  UPDATE public.integration_plugins
     SET status = 'disabled',
         active_version_id = NULL,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{deactivation}',
           jsonb_strip_nulls(jsonb_build_object(
             'plugin_version_id', v_version.id,
             'deactivated_at', now(),
             'deactivated_by', v_user_id,
             'reason', v_reason,
             'changed_count', v_changed,
             'binding_count', v_binding_count
           )),
           TRUE
         ),
         updated_by = v_user_id,
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
    'deactivated',
    v_user_id,
    v_reason,
    public.integration_plugin_hash_payload_v1(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'previous_status', v_plugin.status,
      'previous_active_version_id', v_plugin.active_version_id,
      'changed_count', v_changed,
      'binding_count', v_binding_count
    )),
    v_artifact_hash,
    jsonb_strip_nulls(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'previous_status', v_plugin.status,
      'previous_active_version_id', v_plugin.active_version_id,
      'version_status', 'approved',
      'status', 'disabled',
      'changed_count', v_changed,
      'binding_count', v_binding_count
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'action', 'deactivated',
    'plugin_id', v_plugin.id,
    'integration_plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'integration_plugin_version_id', v_version.id,
    'status', 'disabled',
    'version_status', 'approved',
    'changed_count', v_changed,
    'binding_count', v_binding_count,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.plugin_set_binding_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_version_id UUID;
  v_enabled BOOLEAN;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_changed INTEGER;
  v_plugin public.integration_plugins%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_version_id := NULLIF(p_args->>'plugin_version_id', '')::UUID;
  EXCEPTION WHEN others THEN v_version_id := NULL; END;

  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 requires plugin_version_id'
      USING ERRCODE = '23502';
  END IF;

  IF (p_args->'enabled') IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 requires enabled boolean'
      USING ERRCODE = '23502';
  END IF;

  v_enabled := COALESCE((p_args->>'enabled')::BOOLEAN, NULL);
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 enabled must be boolean'
      USING ERRCODE = '22023';
  END IF;

  v_scope_type := lower(NULLIF(btrim(COALESCE(p_args->>'scope_type', '')), ''));
  BEGIN v_scope_id := NULLIF(p_args->>'scope_id', '')::UUID;
  EXCEPTION WHEN others THEN v_scope_id := NULL; END;

  -- Resolve plugin for tenant isolation + capability check.
  SELECT * INTO v_version
    FROM public.integration_plugin_versions
   WHERE id = v_version_id
   LIMIT 1;
  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 plugin_version_id % not found', v_version_id
      USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_version.plugin_id
   LIMIT 1;
  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 plugin % not found', v_version.plugin_id
      USING ERRCODE = '23503';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 plugin % outside tenant scope', v_plugin.id
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  -- Toggle bindings + linked runtime rows.
  v_changed := public.integration_plugin_set_binding_runtime_enabled_v1(
    v_version_id, v_enabled, v_scope_type, v_scope_id
  );

  -- Audit ledger.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_plugin.organization_id, 'integration_plugin.set_binding',
    'integration_plugin_version', v_version_id,
    'plugin_set_binding_v1',
    CASE WHEN v_enabled THEN 'binding_enabled' ELSE 'binding_disabled' END,
    jsonb_strip_nulls(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version_id,
      'enabled', v_enabled,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'changed_count', v_changed
    )),
    'plugin_set_binding_v1',
    v_correlation_id::uuid
  );

  -- Domain event.
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_plugin.organization_id,
    CASE WHEN v_enabled THEN 'integration_plugin.binding_enabled' ELSE 'integration_plugin.binding_disabled' END,
    'integration_plugin_version', v_version_id,
    jsonb_strip_nulls(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'enabled', v_enabled,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'changed_count', v_changed
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version_id,
    'enabled', v_enabled,
    'changed_count', v_changed,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_upsert_provider_auth_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_config_id uuid := COALESCE(
    NULLIF(p_args->>'config_id', '')::uuid,
    NULLIF(p_args->>'provider_auth_config_id', '')::uuid
  );
  v_is_create boolean := v_config_id IS NULL;
  v_provider_id uuid := NULLIF(p_args->>'provider_id', '')::uuid;
  v_auth_type text := NULLIF(btrim(p_args->>'auth_type'), '');
  v_credentials jsonb := CASE WHEN p_args ? 'credentials' THEN p_args->'credentials' ELSE NULL END;
  v_credentials_vault_id uuid := NULLIF(p_args->>'credentials_vault_id', '')::uuid;
  v_expires_at timestamptz := NULLIF(p_args->>'expires_at', '')::timestamptz;
  v_existing_provider_id uuid;
  v_existing_credentials_vault_id uuid;
  v_existing_credentials jsonb;
  v_target_org uuid;
  v_secret_name text;
  v_secret_description text;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write');

  IF v_is_create AND v_config_id IS NULL THEN
    v_config_id := gen_random_uuid();
  END IF;

  IF v_is_create THEN
    IF v_provider_id IS NULL OR v_auth_type IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires provider_id and auth_type for create'
        USING ERRCODE = '23502';
    END IF;
    IF v_credentials IS NULL AND v_credentials_vault_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires credentials or credentials_vault_id for create'
        USING ERRCODE = '23502';
    END IF;
  END IF;

  IF NOT v_is_create THEN
    SELECT pac.provider_id, pac.credentials_vault_id, pac.credentials, p.organization_id
      INTO v_existing_provider_id, v_existing_credentials_vault_id, v_existing_credentials, v_target_org
      FROM public.provider_auth_configs pac
      JOIN public.providers p ON p.id = pac.provider_id
     WHERE pac.id = v_config_id
     LIMIT 1;

    IF v_existing_provider_id IS NULL OR v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % not found', v_config_id
        USING ERRCODE = '23503';
    END IF;

    IF lower(COALESCE(v_existing_credentials->>'revoked', 'false')) NOT IN ('false', 'f', 'no', 'n', '0', 'off') THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % is revoked and cannot be updated', v_config_id
        USING ERRCODE = '55000';
    END IF;

    IF v_provider_id IS NULL THEN
      v_provider_id := v_existing_provider_id;
    ELSIF v_provider_id <> v_existing_provider_id THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 config % belongs to provider %, not %',
        v_config_id, v_existing_provider_id, v_provider_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_is_create THEN
    SELECT organization_id INTO v_target_org
      FROM public.providers
     WHERE id = v_provider_id;
  END IF;

  IF v_provider_id IS NULL OR v_target_org IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider % not found', v_provider_id
      USING ERRCODE = '23503';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_target_org THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider % outside tenant scope', v_provider_id
      USING ERRCODE = '42501';
  END IF;

  IF v_credentials IS NOT NULL THEN
    IF jsonb_typeof(v_credentials) <> 'object' THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 credentials must be a JSON object'
        USING ERRCODE = '22023';
    END IF;

    v_secret_name := format('provider_auth_configs/%s', v_config_id);
    v_secret_description := format('Console V2 provider credential %s', v_secret_name);

    IF NOT v_is_create AND COALESCE(v_credentials_vault_id, v_existing_credentials_vault_id) IS NOT NULL THEN
      v_credentials_vault_id := COALESCE(v_credentials_vault_id, v_existing_credentials_vault_id);
      PERFORM vault.update_secret(
        v_credentials_vault_id,
        v_credentials::text,
        v_secret_name,
        v_secret_description,
        NULL
      );
    ELSE
      SELECT vault.create_secret(
        v_credentials::text,
        v_secret_name,
        v_secret_description,
        NULL
      )
        INTO v_credentials_vault_id;
    END IF;
  END IF;

  IF v_is_create THEN
    INSERT INTO public.provider_auth_configs (
      id,
      provider_id,
      auth_type,
      credentials,
      credentials_vault_id,
      expires_at,
      last_rotated_at
    ) VALUES (
      v_config_id,
      v_provider_id,
      v_auth_type,
      NULL,
      v_credentials_vault_id,
      v_expires_at,
      CASE
        WHEN v_credentials IS NOT NULL OR v_credentials_vault_id IS NOT NULL THEN now()
        ELSE NULL
      END
    )
    RETURNING id INTO v_config_id;
  ELSE
    UPDATE public.provider_auth_configs
       SET auth_type = COALESCE(v_auth_type, auth_type),
           credentials = CASE
             WHEN v_credentials IS NOT NULL OR v_credentials_vault_id IS NOT NULL THEN NULL
             ELSE credentials
           END,
           credentials_vault_id = COALESCE(v_credentials_vault_id, credentials_vault_id),
           expires_at = CASE WHEN p_args ? 'expires_at' THEN v_expires_at ELSE expires_at END,
           last_rotated_at = CASE
             WHEN v_credentials IS NOT NULL OR v_credentials_vault_id IS NOT NULL THEN now()
             ELSE last_rotated_at
           END
     WHERE id = v_config_id
       AND provider_id = v_provider_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % not found', v_config_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'provider_auth_config_id', v_config_id,
    'auth_config_id', v_config_id,
    'credentials_vaulted', true,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_bind_provider_account_credential_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := COALESCE(public.is_platform_user(), FALSE);
  v_target_org_id UUID := COALESCE(
    NULLIF(p_args->>'organization_id', '')::uuid,
    NULLIF(p_args->>'tenant_id', '')::uuid,
    CASE WHEN NULLIF(p_args->>'scope_type', '') = 'tenant' THEN NULLIF(p_args->>'scope_id', '')::uuid ELSE NULL END,
    v_user_org_id
  );
  v_scope_type TEXT := COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'tenant');
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_source_id UUID := COALESCE(NULLIF(p_args->>'source_id', '')::uuid, CASE WHEN v_scope_type = 'source' THEN v_scope_id ELSE NULL END);
  v_route_id UUID := NULLIF(p_args->>'route_id', '')::uuid;
  v_route_method TEXT := upper(COALESCE(NULLIF(btrim(p_args->>'route_method'), ''), NULLIF(btrim(p_args->>'method'), '')));
  v_route_path TEXT := COALESCE(NULLIF(btrim(p_args->>'route_path'), ''), NULLIF(btrim(p_args->>'path_template'), ''));
  v_route_provider_id UUID;
  v_route_category TEXT;
  v_route_auth_type TEXT;
  v_requested_provider_id UUID := NULLIF(p_args->>'provider_id', '')::uuid;
  v_provider_id UUID := v_requested_provider_id;
  v_provider_org_id UUID;
  v_nil_org UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_requested_provider_account_category TEXT := COALESCE(
    NULLIF(btrim(p_args->>'provider_account_category'), ''),
    NULLIF(btrim(p_args->>'category'), '')
  );
  v_provider_account_category TEXT := v_requested_provider_account_category;
  v_requested_auth_type TEXT := NULLIF(btrim(p_args->>'auth_type'), '');
  v_auth_type TEXT := COALESCE(v_requested_auth_type, 'basic_auth');
  v_auth_config_id UUID := COALESCE(
    NULLIF(p_args->>'auth_config_id', '')::uuid,
    NULLIF(p_args->>'provider_auth_config_id', '')::uuid,
    NULLIF(p_args->>'config_id', '')::uuid
  );
  v_credentials JSONB := CASE WHEN p_args ? 'credentials' THEN p_args->'credentials' ELSE NULL END;
  v_credentials_vault_id UUID := NULLIF(p_args->>'credentials_vault_id', '')::uuid;
  v_expires_at TIMESTAMPTZ := NULLIF(p_args->>'expires_at', '')::timestamptz;
  v_company_id TEXT := NULLIF(btrim(COALESCE(p_args->>'company_id', p_args #>> '{provider_account,company_id}')), '');
  v_existing JSONB := NULL;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_settings_version_number INT;
  v_existing_config RECORD;
  v_secret_name TEXT;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write');

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires tenant organization scope'
      USING ERRCODE = '23502';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND v_is_platform IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_target_org_id THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 tenant % outside caller scope', v_target_org_id
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type NOT IN ('tenant', 'source') THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 unsupported scope_type %', v_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF v_scope_type = 'tenant' THEN
    v_scope_id := v_target_org_id;
  ELSIF v_scope_type = 'source' THEN
    IF v_source_id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 source scope requires source_id'
        USING ERRCODE = '23502';
    END IF;

    SELECT ws.organization_id
      INTO v_target_org_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_source_id
     LIMIT 1;

    IF v_target_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 source % not found', v_source_id
        USING ERRCODE = '23503';
    END IF;

    IF public.request_role_is_service_v1() IS NOT TRUE
       AND v_is_platform IS NOT TRUE
       AND public.current_user_org_id() IS DISTINCT FROM v_target_org_id THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 source % outside caller scope', v_source_id
        USING ERRCODE = '42501';
    END IF;

    v_scope_id := v_source_id;
  END IF;

  IF v_route_id IS NOT NULL OR (v_route_method IS NOT NULL AND v_route_path IS NOT NULL) THEN
    SELECT r.id,
           r.provider_id,
           NULLIF(r.policy #>> '{provider_account,category}', ''),
           NULLIF(r.policy #>> '{auth,auth_type}', '')
      INTO v_route_id,
           v_route_provider_id,
           v_route_category,
           v_route_auth_type
      FROM public.api_routes r
      JOIN public.api_route_packs p ON p.id = r.pack_id
     WHERE r.enabled = TRUE
       AND p.enabled = TRUE
       AND (
         (v_route_id IS NOT NULL AND r.id = v_route_id)
         OR (
           v_route_id IS NULL
           AND upper(r.method) = v_route_method
           AND r.path_template = v_route_path
         )
       )
     ORDER BY CASE r.scope_type
                WHEN 'source' THEN 1
                WHEN 'sender' THEN 2
                WHEN 'client' THEN 3
                WHEN 'tenant' THEN 4
                ELSE 5
              END,
              r.updated_at DESC
     LIMIT 1;

    IF v_route_id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 API route not found'
        USING ERRCODE = '23503';
    END IF;

    IF v_route_category IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 API route % has no provider_account category', v_route_id
        USING ERRCODE = '23514';
    END IF;

    IF v_route_provider_id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 API route % has no provider_id', v_route_id
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_provider_account_category IS NOT NULL
       AND v_requested_provider_account_category <> v_route_category THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider_account_category % conflicts with route policy %',
        v_requested_provider_account_category, v_route_category
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_provider_id IS NOT NULL
       AND v_requested_provider_id <> v_route_provider_id THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider_id % conflicts with route provider %',
        v_requested_provider_id, v_route_provider_id
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_auth_type IS NOT NULL
       AND v_route_auth_type IS NOT NULL
       AND v_requested_auth_type <> v_route_auth_type THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 auth_type % conflicts with route policy %',
        v_requested_auth_type, v_route_auth_type
        USING ERRCODE = '23514';
    END IF;

    v_provider_id := v_route_provider_id;
    v_provider_account_category := v_route_category;
    v_auth_type := COALESCE(v_route_auth_type, v_requested_auth_type, 'basic_auth');
  END IF;

  IF v_provider_account_category IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires provider_account_category or route reference'
      USING ERRCODE = '23502';
  END IF;

  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires provider_id or route reference'
      USING ERRCODE = '23502';
  END IF;

  SELECT p.organization_id
    INTO v_provider_org_id
    FROM public.providers p
   WHERE p.id = v_provider_id
   LIMIT 1;

  IF v_provider_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider % not found', v_provider_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_platform
     AND v_provider_org_id NOT IN (v_target_org_id, v_nil_org) THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider % outside caller scope', v_provider_id
      USING ERRCODE = '42501';
  END IF;

  SELECT cached_value
    INTO v_existing
    FROM public.settings
   WHERE category = v_provider_account_category
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM v_scope_id
   LIMIT 1;

  IF v_company_id IS NULL THEN
    v_company_id := NULLIF(COALESCE(v_existing->>'company_id', ''), '');
  END IF;

  IF v_company_id IS NULL THEN
    SELECT NULLIF(resolved.value->>'company_id', '')
      INTO v_company_id
      FROM public.resolve_settings_row(v_provider_account_category, v_scope_type, v_scope_id) AS resolved
     LIMIT 1;
  END IF;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires company_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_auth_config_id IS NULL THEN
    IF v_credentials_vault_id IS NULL AND v_credentials IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 requires auth_config_id or credentials'
        USING ERRCODE = '23502';
    END IF;

    IF v_credentials IS NOT NULL THEN
      IF jsonb_typeof(v_credentials) <> 'object' THEN
        RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 credentials must be a JSON object'
          USING ERRCODE = '22023';
      END IF;

      IF v_auth_type = 'basic_auth'
         AND (
           NULLIF(v_credentials->>'username', '') IS NULL
           OR NULLIF(v_credentials->>'password', '') IS NULL
         ) THEN
        RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 basic_auth credentials require username and password'
          USING ERRCODE = '23502';
      END IF;

      v_auth_config_id := gen_random_uuid();
      v_secret_name := format('provider_auth_configs/%s', v_auth_config_id);
      SELECT vault.create_secret(
        v_credentials::text,
        v_secret_name,
        format('Console V2 provider account credential binding %s', v_auth_config_id),
        NULL
      )
        INTO v_credentials_vault_id;
    ELSE
      v_auth_config_id := gen_random_uuid();
    END IF;

    INSERT INTO public.provider_auth_configs (
      id,
      provider_id,
      auth_type,
      credentials_vault_id,
      credentials,
      expires_at
    ) VALUES (
      v_auth_config_id,
      v_provider_id,
      v_auth_type,
      v_credentials_vault_id,
      NULL,
      v_expires_at
    );
  ELSE
    SELECT pac.id, pac.provider_id, pac.auth_type, p.organization_id AS provider_org_id
      INTO v_existing_config
      FROM public.provider_auth_configs pac
      JOIN public.providers p ON p.id = pac.provider_id
     WHERE pac.id = v_auth_config_id
     LIMIT 1;

    IF v_existing_config.id IS NULL THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider_auth_config % not found', v_auth_config_id
        USING ERRCODE = '23503';
    END IF;

    IF v_existing_config.auth_type <> v_auth_type THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 auth_type mismatch: config % is %, route expects %',
        v_auth_config_id, v_existing_config.auth_type, v_auth_type
        USING ERRCODE = '23514';
    END IF;

    IF v_existing_config.provider_id <> v_provider_id THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 provider mismatch: config % belongs to provider %, route expects %',
        v_auth_config_id, v_existing_config.provider_id, v_provider_id
        USING ERRCODE = '23514';
    END IF;

    IF NOT v_is_platform
       AND v_existing_config.provider_org_id NOT IN (v_target_org_id, v_nil_org) THEN
      RAISE EXCEPTION 'ui_bind_provider_account_credential_v1 credential % outside caller scope', v_auth_config_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT us.settings_id, us.settings_version_id, us.settings_version_number
    INTO v_settings_id, v_settings_version_id, v_settings_version_number
    FROM public.upsert_settings_value_v1(
      v_provider_account_category,
      v_scope_type,
      v_scope_id,
      jsonb_strip_nulls(jsonb_build_object(
        'enabled', COALESCE((p_args->>'enabled')::boolean, TRUE),
        'company_id', v_company_id,
        'auth_config_id', v_auth_config_id::text,
        'notes', NULLIF(btrim(p_args->>'notes'), '')
      )),
      1,
      COALESCE(NULLIF(btrim(p_args->>'reason'), ''), 'Console V2 provider account credential binding')
    ) AS us;

  PERFORM public.log_decision(
    p_organization_id := v_target_org_id,
    p_decision_category := 'settings',
    p_resource_type := 'settings',
    p_resource_id := v_settings_id,
    p_decision_point := 'provider_account_credential_bound',
    p_decision_outcome := 'bound',
    p_performed_by_system := format('console_v2:%s', v_user_id),
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'provider_account_category', v_provider_account_category,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'provider_id', v_provider_id,
      'route_id', v_route_id,
      'auth_type', v_auth_type,
      'auth_config_id', v_auth_config_id,
      'company_id', v_company_id,
      'credentials_vault_id', v_credentials_vault_id
    )),
    p_decision_reason := 'Provider account credential binding updated through Console V2.'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'provider_account_category', v_provider_account_category,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'organization_id', v_target_org_id,
    'provider_id', v_provider_id,
    'route_id', v_route_id,
    'auth_type', v_auth_type,
    'provider_auth_config_id', v_auth_config_id,
    'auth_config_id', v_auth_config_id,
    'credentials_vault_id', v_credentials_vault_id,
    'company_id', v_company_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'settings_version_number', v_settings_version_number,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_upsert_api_gateway_route_mapping_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := COALESCE(
    public.mapping_studio_try_uuid_v1(p_args->>'organization_id'),
    public.current_user_org_id()
  );
  v_route_id UUID := public.mapping_studio_try_uuid_v1(p_args->>'api_route_id');
  v_mapping_id UUID := public.mapping_studio_try_uuid_v1(p_args->>'mapping_config_id');
  v_route public.api_routes%ROWTYPE;
  v_mapping public.mapping_configs%ROWTYPE;
  v_target TEXT;
  v_scope_type TEXT;
  v_route_intent TEXT;
  v_mapping_intent TEXT;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires object args';
  END IF;
  IF v_org_id IS NULL OR v_route_id IS NULL OR v_mapping_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_api_gateway_route_mapping_v1 requires organization, api_route_id, and mapping_config_id';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'Capability denied: api_routes.write' USING ERRCODE = '42501';
  END IF;

  IF NOT public.request_role_is_service_v1()
     AND public.user_has_resource_capability_v1('api_routes', 'write', 'tenant', v_org_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Capability denied: api_routes.write' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);

  SELECT * INTO v_route FROM public.api_routes WHERE id = v_route_id LIMIT 1;
  IF v_route.id IS NULL THEN
    RAISE EXCEPTION 'api_gateway route % is not available in this tenant scope', v_route_id;
  END IF;

  SELECT *
  INTO v_mapping
  FROM public.mapping_configs
  WHERE id = v_mapping_id
    AND mapping_type = 'api_gateway_inbound'
    AND (organization_id IS NULL OR organization_id = v_org_id)
  LIMIT 1;
  IF v_mapping.id IS NULL THEN
    RAISE EXCEPTION 'api_gateway_inbound mapping config % is not available in this tenant scope', v_mapping_id;
  END IF;

  v_target := COALESCE(NULLIF(v_mapping.mapping_config->>'target', ''), NULLIF(p_args->>'target', ''));
  v_scope_type := lower(COALESCE(NULLIF(v_route.scope_type, ''), 'global'));
  v_route_intent := public.api_gateway_route_canonical_intent_v1(COALESCE(v_route.policy, '{}'::jsonb));
  v_mapping_intent := public.api_gateway_mapping_target_intent_v1(v_target);

  IF v_scope_type = 'global' THEN
    IF public.user_has_capability_v1('system.write', 'tenant', v_org_id) IS FALSE THEN
      RAISE EXCEPTION 'api_gateway global route % is service-managed for tenant mapping', v_route_id;
    END IF;
  ELSIF v_scope_type = 'tenant' THEN
    IF v_route.scope_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'api_gateway tenant route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'client' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = v_route.scope_id AND c.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway client route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'sender' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = v_route.scope_id AND c.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway sender route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSIF v_scope_type = 'source' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.webhook_sources ws
      WHERE ws.id = v_route.scope_id AND ws.organization_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'api_gateway source route % is not owned by organization %', v_route_id, v_org_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'api_gateway route % has unsupported scope_type %', v_route_id, v_scope_type;
  END IF;

  IF public.api_gateway_mapping_intents_compatible_v1(v_route_intent, v_mapping_intent) IS FALSE THEN
    RAISE EXCEPTION 'api_gateway mapping target % is incompatible with route intent %',
      COALESCE(v_target, ''), COALESCE(v_route_intent, '');
  END IF;

  UPDATE public.api_routes
  SET policy = public.deep_merge_jsonb(
        COALESCE(policy, '{}'::jsonb),
        jsonb_build_object(
          'request_mapping',
          jsonb_strip_nulls(jsonb_build_object(
            'mapping_config_id', v_mapping.id,
            'mapping_key', v_mapping.mapping_key,
            'mapping_type', v_mapping.mapping_type,
            'target', v_target,
            'route_intent', v_route_intent,
            'mapping_intent', v_mapping_intent,
            'route_scope_type', v_scope_type,
            'route_scope_id', v_route.scope_id,
            'saved_at', now(),
            'saved_by', v_user_id
          ))
        )
      ),
      updated_at = now()
  WHERE id = v_route.id
  RETURNING * INTO v_route;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'api_route_id', v_route.id,
    'mapping_config_id', v_mapping.id,
    'mapping_key', v_mapping.mapping_key,
    'mapping_type', v_mapping.mapping_type,
    'mapping_target', v_target,
    'route_intent', v_route_intent,
    'mapping_intent', v_mapping_intent,
    'route_scope_type', v_scope_type,
    'route_scope_id', v_route.scope_id,
    'policy', v_route.policy
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_migrate_runtime_assets_v1(
  p_kind TEXT,
  p_runtime_id UUID,
  p_plugin_name TEXT,
  p_workflow_binding JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_kind TEXT := lower(COALESCE(NULLIF(btrim(p_kind), ''), ''));
  v_route public.api_routes%ROWTYPE;
  v_source public.webhook_sources%ROWTYPE;
  v_result JSONB;
BEGIN
  IF v_kind NOT IN ('api_route', 'webhook_source') THEN
    RAISE EXCEPTION 'integration_plugin_migrate_runtime_assets_v1 kind must be api_route|webhook_source';
  END IF;

  IF p_runtime_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_migrate_runtime_assets_v1 requires runtime_id';
  END IF;

  IF v_kind = 'api_route' THEN
    SELECT * INTO v_route
    FROM public.api_routes r
    WHERE r.id = p_runtime_id
    LIMIT 1;

    IF v_route.id IS NULL THEN
      RAISE EXCEPTION 'integration_plugin_migrate_runtime_assets_v1 api_route % not found', p_runtime_id;
    END IF;

    v_result := public.integration_plugin_generate_draft_v1(
      p_plugin_name := p_plugin_name,
      p_plugin_kind := 'api',
      p_source_type := 'manual',
      p_source_payload := jsonb_build_object('migration_source', 'api_route', 'runtime_id', p_runtime_id),
      p_inbound_config := jsonb_build_object(
        'route', jsonb_build_object(
          'method', v_route.method,
          'path_template', v_route.path_template,
          'upstream_method', v_route.upstream_method,
          'upstream_path_template', v_route.upstream_path_template,
          'policy', COALESCE(v_route.policy, '{}'::jsonb)
        )
      ),
      p_mapping_config := '{}'::jsonb,
      p_workflow_binding := COALESCE(p_workflow_binding, '{}'::jsonb),
      p_outbound_operations := '[]'::jsonb,
      p_plugin_id := NULL,
      p_plugin_key := NULL,
      p_description := format('Migrated from api_routes/%s', p_runtime_id),
      p_organization_id := NULL,
      p_metadata := jsonb_build_object('migration_source', 'api_route', 'runtime_id', p_runtime_id)
    );

    RETURN v_result || jsonb_build_object('migration_kind', v_kind, 'runtime_id', p_runtime_id);
  END IF;

  SELECT * INTO v_source
  FROM public.webhook_sources ws
  WHERE ws.id = p_runtime_id
  LIMIT 1;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_migrate_runtime_assets_v1 webhook_source % not found', p_runtime_id;
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_source.organization_id THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.write' USING ERRCODE = '42501';
  END IF;

  v_result := public.integration_plugin_generate_draft_v1(
    p_plugin_name := p_plugin_name,
    p_plugin_kind := 'webhook',
    p_source_type := 'manual',
    p_source_payload := jsonb_build_object('migration_source', 'webhook_source', 'runtime_id', p_runtime_id),
    p_inbound_config := jsonb_build_object(
      'webhook', jsonb_build_object(
        'source_identifier', v_source.source_identifier,
        'name', v_source.name,
        'provider_type', v_source.provider_type
      )
    ),
    p_mapping_config := COALESCE((SELECT mc.mapping_config FROM public.mapping_configs mc WHERE mc.id = v_source.mapping_config_id), '{}'::jsonb),
    p_workflow_binding := COALESCE(p_workflow_binding, '{}'::jsonb),
    p_outbound_operations := '[]'::jsonb,
    p_plugin_id := NULL,
    p_plugin_key := NULL,
    p_description := format('Migrated from webhook_sources/%s', p_runtime_id),
    p_organization_id := v_source.organization_id,
    p_metadata := jsonb_build_object('migration_source', 'webhook_source', 'runtime_id', p_runtime_id)
  );

  RETURN v_result || jsonb_build_object('migration_kind', v_kind, 'runtime_id', p_runtime_id);
END;
$function$;

COMMIT;
