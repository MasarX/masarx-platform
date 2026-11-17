-- Effective current marketplace lifecycle, with explicit source/target authorization and atomic transitions.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20261019022000_automation_marketplace_rpcs_v1'));

CREATE OR REPLACE FUNCTION public.automation_marketplace_hash_payload_v1(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT encode(extensions.digest(COALESCE(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex');
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_next_listing_version_no_v1(p_listing_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COALESCE(MAX(v.listing_version_no), 0) + 1
  FROM public.automation_asset_listing_versions v
  WHERE v.listing_id = p_listing_id;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_secret_text_v1(p_secret_payload JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_secret_payload, '{}'::jsonb);
  v_text TEXT;
BEGIN
  IF jsonb_typeof(v_payload) = 'string' THEN
    RETURN v_payload #>> '{}';
  END IF;

  IF jsonb_typeof(v_payload) <> 'object' THEN
    RETURN NULL;
  END IF;

  v_text := NULLIF(COALESCE(v_payload->>'secret', ''), '');
  IF v_text IS NOT NULL THEN
    RETURN v_text;
  END IF;

  v_text := NULLIF(COALESCE(v_payload->>'token', ''), '');
  IF v_text IS NOT NULL THEN
    RETURN v_text;
  END IF;

  v_text := NULLIF(COALESCE(v_payload->>'value', ''), '');
  IF v_text IS NOT NULL THEN
    RETURN v_text;
  END IF;

  v_text := NULLIF(COALESCE(v_payload->>'access_token', ''), '');
  IF v_text IS NOT NULL THEN
    RETURN v_text;
  END IF;

  v_text := NULLIF(COALESCE(v_payload->>'refresh_token', ''), '');
  RETURN v_text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_store_secret_payload_v1(
  p_existing_vault_id UUID,
  p_secret_payload JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_secret_id UUID := p_existing_vault_id;
BEGIN
  IF p_secret_payload IS NULL OR p_secret_payload = 'null'::jsonb THEN
    RETURN v_secret_id;
  END IF;

  IF v_secret_id IS NULL THEN
    SELECT vault.create_secret(p_secret_payload::text) INTO v_secret_id;
  ELSE
    PERFORM vault.update_secret(v_secret_id, p_secret_payload::text);
  END IF;

  RETURN v_secret_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_resolve_policy_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := COALESCE(NULLIF(btrim(COALESCE(p_scope_type, '')), ''), public.current_user_scope_type(), public.get_root_scope_type_key_v1());
  v_scope_id UUID := COALESCE(p_scope_id, public.current_user_scope_id());
  v_org_id UUID := COALESCE(
    p_organization_id,
    CASE
      WHEN v_scope_type IS NULL OR lower(v_scope_type) IN (public.get_root_scope_type_key_v1(), 'platform') THEN NULL
      ELSE public.resolve_organization_id_for_scope_v1(v_scope_type, v_scope_id)
    END,
    public.current_user_org_id()
  );
BEGIN
  IF v_scope_type IS NULL THEN
    v_scope_type := CASE WHEN v_org_id IS NULL THEN public.get_root_scope_type_key_v1() ELSE 'tenant' END;
  END IF;

  IF (v_scope_id IS NULL AND v_scope_type = 'tenant' AND v_org_id IS NOT NULL) THEN
    v_scope_id := v_org_id;
  END IF;

  IF v_scope_type = public.get_root_scope_type_key_v1() OR v_scope_id IS NULL THEN
    RETURN COALESCE(public.resolve_settings_merged('automation_marketplace_policy', public.get_root_scope_type_key_v1(), NULL), '{}'::jsonb);
  END IF;

  RETURN COALESCE(public.resolve_settings_merged('automation_marketplace_policy', v_scope_type, v_scope_id), '{}'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_extract_placeholders_v1(p_payload JSONB)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_text TEXT := COALESCE(p_payload, '{}'::jsonb)::text;
  v_match TEXT[];
  v_out TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR v_match IN
    SELECT regexp_matches(v_text, '\{\{([a-zA-Z0-9_.-]+)\}\}', 'g')
  LOOP
    IF v_match[1] IS NOT NULL AND NOT (v_match[1] = ANY(v_out)) THEN
      v_out := array_append(v_out, v_match[1]);
    END IF;
  END LOOP;

  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_manifest_keys_v1(
  p_manifest JSONB,
  p_category TEXT
)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_manifest JSONB := COALESCE(p_manifest, '{}'::jsonb);
  v_keys TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_category = 'variables' THEN
    IF jsonb_typeof(v_manifest #> '{variable_schema,keys}') = 'array' THEN
      SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
        INTO v_keys
        FROM jsonb_array_elements_text(v_manifest #> '{variable_schema,keys}') AS value;
      RETURN v_keys;
    END IF;

    IF jsonb_typeof(v_manifest #> '{variable_schema,properties}') = 'object' THEN
      SELECT COALESCE(array_agg(key), ARRAY[]::TEXT[])
        INTO v_keys
        FROM jsonb_object_keys(v_manifest #> '{variable_schema,properties}') AS key;
      RETURN v_keys;
    END IF;

    IF jsonb_typeof(v_manifest->'variable_schema') = 'object' THEN
      SELECT COALESCE(array_agg(key), ARRAY[]::TEXT[])
        INTO v_keys
        FROM jsonb_object_keys(v_manifest->'variable_schema') AS key
       WHERE key NOT IN ('keys', 'properties', 'required', 'type', 'title', 'description');
      RETURN v_keys;
    END IF;
  ELSIF p_category = 'connections' THEN
    IF jsonb_typeof(v_manifest #> '{connection_requirements,bindings}') = 'array' THEN
      SELECT COALESCE(array_agg(DISTINCT COALESCE(value->>'key', value#>>'{}')), ARRAY[]::TEXT[])
        INTO v_keys
        FROM jsonb_array_elements(v_manifest #> '{connection_requirements,bindings}') AS value
       WHERE COALESCE(value->>'key', value#>>'{}') <> '';
      RETURN v_keys;
    END IF;

    IF jsonb_typeof(v_manifest->'connection_requirements') = 'object' THEN
      SELECT COALESCE(array_agg(key), ARRAY[]::TEXT[])
        INTO v_keys
        FROM jsonb_object_keys(v_manifest->'connection_requirements') AS key
       WHERE key <> 'bindings';
      RETURN v_keys;
    END IF;
  ELSIF p_category = 'scope' THEN
    IF jsonb_typeof(v_manifest #> '{install_constraints,allowed_scope_placeholders}') = 'array' THEN
      SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
        INTO v_keys
        FROM jsonb_array_elements_text(v_manifest #> '{install_constraints,allowed_scope_placeholders}') AS value;
      RETURN v_keys;
    END IF;

    IF jsonb_typeof(v_manifest #> '{install_constraints,allowed_scope_fields}') = 'array' THEN
      SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
        INTO v_keys
        FROM jsonb_array_elements_text(v_manifest #> '{install_constraints,allowed_scope_fields}') AS value;
      RETURN v_keys;
    END IF;
  END IF;

  RETURN v_keys;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_dependency_contract_errors_v1(
  p_dependency_requirements JSONB
)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_dependency JSONB := COALESCE(p_dependency_requirements, '{}'::jsonb);
  v_errors TEXT[] := ARRAY[]::TEXT[];
  v_asset JSONB;
BEGIN
  IF jsonb_typeof(v_dependency) <> 'object' THEN
    RETURN ARRAY['manifest.dependency_requirements must be a JSON object'];
  END IF;

  IF v_dependency ? 'required_assets' THEN
    IF jsonb_typeof(v_dependency->'required_assets') <> 'array' THEN
      v_errors := array_append(v_errors, 'manifest.dependency_requirements.required_assets must be an array');
    ELSE
      FOR v_asset IN
        SELECT value
        FROM jsonb_array_elements(v_dependency->'required_assets')
      LOOP
        IF jsonb_typeof(v_asset) <> 'object' THEN
          v_errors := array_append(v_errors, 'manifest.dependency_requirements.required_assets entries must be objects');
        ELSIF NULLIF(COALESCE(v_asset->>'asset_kind', ''), '') IS NULL THEN
          v_errors := array_append(v_errors, 'manifest.dependency_requirements.required_assets entries must declare asset_kind');
        ELSIF NULLIF(COALESCE(v_asset->>'dependency_key', v_asset->>'key', v_asset->>'lookup', ''), '') IS NULL THEN
          v_errors := array_append(v_errors, 'manifest.dependency_requirements.required_assets entries must declare dependency_key or key');
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF v_dependency ? 'required_capabilities' AND jsonb_typeof(v_dependency->'required_capabilities') <> 'array' THEN
    v_errors := array_append(v_errors, 'manifest.dependency_requirements.required_capabilities must be an array');
  END IF;

  IF v_dependency ? 'required_connections' AND jsonb_typeof(v_dependency->'required_connections') <> 'array' THEN
    v_errors := array_append(v_errors, 'manifest.dependency_requirements.required_connections must be an array');
  END IF;

  RETURN v_errors;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_validate_manifest_v1(
  p_manifest JSONB,
  p_snapshot_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_manifest JSONB := COALESCE(p_manifest, '{}'::jsonb);
  v_snapshot JSONB := COALESCE(p_snapshot_payload, '{}'::jsonb);
  v_scope_scan_snapshot JSONB := COALESCE(p_snapshot_payload, '{}'::jsonb);
  v_errors TEXT[] := ARRAY[]::TEXT[];
  v_warnings TEXT[] := ARRAY[]::TEXT[];
  v_placeholders TEXT[] := public.automation_marketplace_extract_placeholders_v1(v_snapshot);
  v_var_keys TEXT[] := public.automation_marketplace_manifest_keys_v1(v_manifest, 'variables');
  v_conn_keys TEXT[] := public.automation_marketplace_manifest_keys_v1(v_manifest, 'connections');
  v_scope_keys TEXT[] := public.automation_marketplace_manifest_keys_v1(v_manifest, 'scope');
  v_dependency_errors TEXT[] := public.automation_marketplace_dependency_contract_errors_v1(
    v_manifest->'dependency_requirements'
  );
  v_placeholder TEXT;
  v_payload_text TEXT := lower(v_snapshot::text);
  v_scope_scan_text TEXT;
BEGIN
  -- Workflow revision snapshots carry their own scope metadata under template.*.
  -- Strip those canonical fields before scanning for hardcoded installer scope ids.
  IF jsonb_typeof(v_scope_scan_snapshot) = 'object' THEN
    v_scope_scan_snapshot := v_scope_scan_snapshot
      #- '{template,scope_id}'
      #- '{template,organization_id}'
      #- '{template,owner_scope_id}'
      #- '{template,tenant_id}'
      #- '{template,client_id}'
      #- '{template,sender_id}';
  END IF;
  v_scope_scan_text := lower(v_scope_scan_snapshot::text);

  IF jsonb_typeof(v_manifest) <> 'object' THEN
    v_errors := array_append(v_errors, 'manifest must be a JSON object');
  END IF;

  IF NOT (v_manifest ? 'display') THEN
    v_errors := array_append(v_errors, 'manifest.display is required');
  END IF;
  IF NOT (v_manifest ? 'docs') THEN
    v_errors := array_append(v_errors, 'manifest.docs is required');
  END IF;
  IF NOT (v_manifest ? 'variable_schema') THEN
    v_errors := array_append(v_errors, 'manifest.variable_schema is required');
  END IF;
  IF NOT (v_manifest ? 'connection_requirements') THEN
    v_errors := array_append(v_errors, 'manifest.connection_requirements is required');
  END IF;
  IF NOT (v_manifest ? 'dependency_requirements') THEN
    v_errors := array_append(v_errors, 'manifest.dependency_requirements is required');
  END IF;
  IF NOT (v_manifest ? 'capability_requirements') THEN
    v_errors := array_append(v_errors, 'manifest.capability_requirements is required');
  END IF;
  IF NOT (v_manifest ? 'install_constraints') THEN
    v_errors := array_append(v_errors, 'manifest.install_constraints is required');
  END IF;
  IF NOT (v_manifest ? 'egress_profile') THEN
    v_errors := array_append(v_errors, 'manifest.egress_profile is required');
  END IF;
  IF NOT (v_manifest ? 'compatibility') THEN
    v_errors := array_append(v_errors, 'manifest.compatibility is required');
  END IF;
  IF NULLIF(COALESCE(v_manifest->>'artifact_hash', ''), '') IS NULL THEN
    v_errors := array_append(v_errors, 'manifest.artifact_hash is required');
  END IF;

  FOREACH v_placeholder IN ARRAY COALESCE(v_placeholders, ARRAY[]::TEXT[])
  LOOP
    IF v_placeholder LIKE 'var.%' THEN
      IF NOT (substring(v_placeholder from 5) = ANY(COALESCE(v_var_keys, ARRAY[]::TEXT[]))) THEN
        v_errors := array_append(
          v_errors,
          format('placeholder %s is not declared in manifest.variable_schema', v_placeholder)
        );
      END IF;
    ELSIF v_placeholder LIKE 'conn.%' OR v_placeholder LIKE 'secret.%' THEN
      IF NOT (split_part(v_placeholder, '.', 2) = ANY(COALESCE(v_conn_keys, ARRAY[]::TEXT[]))) THEN
        v_errors := array_append(
          v_errors,
          format('placeholder %s is not declared in manifest.connection_requirements', v_placeholder)
        );
      END IF;
    ELSIF v_placeholder LIKE 'scope.%' THEN
      IF NOT (substring(v_placeholder from 7) = ANY(COALESCE(v_scope_keys, ARRAY[]::TEXT[]))) THEN
        v_errors := array_append(
          v_errors,
          format(
            'placeholder %s is not allowed by manifest.install_constraints.allowed_scope_placeholders',
            v_placeholder
          )
        );
      END IF;
    ELSE
      v_errors := array_append(
        v_errors,
        format('placeholder namespace for %s is not supported', v_placeholder)
      );
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_dependency_errors, 1), 0) > 0 THEN
    v_errors := v_errors || v_dependency_errors;
  END IF;

  BEGIN
    PERFORM public.automation_marketplace_assert_secret_free_v1(v_snapshot);
    PERFORM public.automation_marketplace_assert_secret_free_v1(v_manifest);
  EXCEPTION WHEN check_violation THEN
    v_errors := array_append(v_errors, 'asset contains credentials or publisher credential references');
  END;

  IF v_scope_scan_text ~ '"(organization_id|owner_scope_id|scope_id|tenant_id|client_id|sender_id)"\s*:\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"' THEN
    v_errors := array_append(v_errors, 'snapshot payload appears to contain hardcoded scope identifiers');
  END IF;

  IF COALESCE(array_length(v_placeholders, 1), 0) = 0 THEN
    v_warnings := array_append(v_warnings, 'snapshot payload contains no install-time placeholders');
  END IF;

  RETURN jsonb_build_object(
    'ok', COALESCE(array_length(v_errors, 1), 0) = 0,
    'errors', to_jsonb(COALESCE(v_errors, ARRAY[]::TEXT[])),
    'warnings', to_jsonb(COALESCE(v_warnings, ARRAY[]::TEXT[])),
    'placeholders', to_jsonb(COALESCE(v_placeholders, ARRAY[]::TEXT[]))
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_unique_workflow_name_v1(p_base_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_base TEXT := left(COALESCE(NULLIF(btrim(p_base_name), ''), 'workflow-marketplace-copy'), 150);
  v_candidate TEXT := v_base;
  v_counter INTEGER := 1;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('marketplace-workflow-name'),hashtext(v_base));
  WHILE EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE wt.name = v_candidate
  ) LOOP
    v_counter := v_counter + 1;
    v_candidate := left(format('%s-copy-%s', v_base, v_counter), 190);
  END LOOP;

  RETURN v_candidate;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_snapshot_workflow_template_v1(
  p_workflow_template_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_template RECORD;
  v_steps JSONB := '[]'::jsonb;
  v_schedule_triggers JSONB := '[]'::jsonb;
  v_run_triggers JSONB := '[]'::jsonb;
BEGIN
  SELECT wt.*
    INTO v_template
    FROM public.workflow_templates wt
   WHERE wt.id = p_workflow_template_id
   LIMIT 1;

  IF v_template.id IS NULL THEN
    RAISE EXCEPTION 'automation_marketplace_snapshot_workflow_template_v1 workflow template % not found', p_workflow_template_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_template.scope_type,v_template.scope_id);
  PERFORM public.assert_capability_v1('automation_marketplace.publish',v_template.scope_type,v_template.scope_id);

  SELECT COALESCE(jsonb_agg(to_jsonb(step) - 'id' - 'workflow_template_id' ORDER BY step.sequence_order), '[]'::jsonb)
    INTO v_steps
    FROM public.workflow_template_steps step
   WHERE step.workflow_template_id = p_workflow_template_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(trigger) - 'id' - 'organization_id' - 'workflow_template_id' - 'last_run_id' ORDER BY trigger.created_at), '[]'::jsonb)
    INTO v_schedule_triggers
    FROM public.workflow_schedule_triggers trigger
   WHERE trigger.workflow_template_id = p_workflow_template_id;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'direction',
               CASE
                 WHEN trigger.target_workflow_template_id = p_workflow_template_id THEN 'incoming'
                 ELSE 'outgoing'
                 END,
               'source_statuses', trigger.source_statuses,
               'context_patch', trigger.context_patch,
               'enabled', trigger.enabled,
               'notes', trigger.notes
             )
             ORDER BY trigger.created_at
           ),
           '[]'::jsonb
         )
    INTO v_run_triggers
    FROM public.workflow_run_triggers trigger
   WHERE trigger.source_workflow_template_id = p_workflow_template_id
      OR trigger.target_workflow_template_id = p_workflow_template_id;

  RETURN jsonb_build_object(
    'template', jsonb_build_object(
      'name', v_template.name,
      'description', v_template.description,
      'version', v_template.version,
      'status', v_template.status,
      'scope_type', v_template.scope_type,
      'scope_id', v_template.scope_id,
      'notes', v_template.notes,
      'steps_checksum', v_template.steps_checksum
    ),
    'steps', COALESCE(v_steps, '[]'::jsonb),
    'schedule_triggers', COALESCE(v_schedule_triggers, '[]'::jsonb),
    'run_triggers', COALESCE(v_run_triggers, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_capture_workflow_revision_v1(
  p_workflow_template_id UUID,
  p_notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_template RECORD;
  v_snapshot JSONB;
  v_revision_id UUID;
  v_revision_no INTEGER;
  v_actor_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'tenant');
  v_actor_scope_id UUID := public.current_user_scope_id();
  v_scope_type TEXT;
  v_scope_id UUID;
  v_org_id UUID;
BEGIN
  IF p_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'automation_marketplace_capture_workflow_revision_v1 requires workflow_template_id';
  END IF;

  SELECT wt.*
    INTO v_template
    FROM public.workflow_templates wt
   WHERE wt.id = p_workflow_template_id
   FOR UPDATE;

  IF v_template.id IS NULL THEN
    RAISE EXCEPTION 'automation_marketplace_capture_workflow_revision_v1 workflow template % not found', p_workflow_template_id;
  END IF;

  v_scope_type := public.normalize_scope_type_v1(
    COALESCE(NULLIF(v_template.scope_type, ''), v_actor_scope_type),
    TRUE
  );
  IF lower(COALESCE(v_template.scope_type, '')) = 'platform' THEN
    v_scope_type := 'global';
  END IF;
  v_scope_id := CASE WHEN v_scope_type = 'global' THEN NULL ELSE v_template.scope_id END;
  v_org_id := COALESCE(
    CASE
      WHEN v_scope_type = 'global' THEN NULL
      ELSE public.resolve_organization_id_for_scope_v1(v_scope_type, v_scope_id)
    END,
    public.current_user_org_id()
  );

  PERFORM public.assert_capability_v1(
    'automation_marketplace.publish',
    v_actor_scope_type,
    v_actor_scope_id
  );

  PERFORM public.automation_marketplace_assert_scope_v1(v_scope_type,v_scope_id,v_org_id);

  v_snapshot := public.automation_marketplace_snapshot_workflow_template_v1(p_workflow_template_id);

  PERFORM public.automation_marketplace_assert_secret_free_v1(v_snapshot);

  SELECT COALESCE(MAX(revision_no), 0) + 1
    INTO v_revision_no
    FROM public.workflow_template_revisions
   WHERE workflow_template_id = p_workflow_template_id;

  INSERT INTO public.workflow_template_revisions (
    workflow_template_id,
    organization_id,
    scope_type,
    scope_id,
    revision_no,
    snapshot,
    artifact_hash,
    notes,
    created_by
  )
  VALUES (
    p_workflow_template_id,
    v_org_id,
    v_scope_type,
    v_scope_id,
    v_revision_no,
    v_snapshot,
    public.automation_marketplace_hash_payload_v1(v_snapshot),
    NULLIF(btrim(COALESCE(p_notes, '')), ''),
    auth.uid()
  )
  RETURNING id INTO v_revision_id;

  RETURN v_revision_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_snapshot_integration_plugin_version_v1(
  p_plugin_version_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_version RECORD;
  v_plugin RECORD;
BEGIN
  SELECT v.*
    INTO v_version
    FROM public.integration_plugin_versions v
   WHERE v.id = p_plugin_version_id
   LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'automation_marketplace_snapshot_integration_plugin_version_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT p.*
    INTO v_plugin
    FROM public.integration_plugins p
   WHERE p.id = v_version.plugin_id
   LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'automation_marketplace_snapshot_integration_plugin_version_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1('tenant',v_plugin.organization_id,v_plugin.organization_id);
  PERFORM public.assert_capability_v1('automation_marketplace.publish','tenant',v_plugin.organization_id);

  RETURN jsonb_build_object(
    'plugin', jsonb_build_object(
      'plugin_key', v_plugin.plugin_key,
      'name', v_plugin.name,
      'description', v_plugin.description,
      'plugin_kind', v_plugin.plugin_kind,
      'status', v_plugin.status,
      'rollout_tier', v_plugin.rollout_tier,
      'reusable_within_tenant', v_plugin.reusable_within_tenant,
      'managed_by', v_plugin.managed_by,
      'metadata', COALESCE(v_plugin.metadata, '{}'::jsonb)
    ),
    'version', jsonb_build_object(
      'version_no', v_version.version_no,
      'status', v_version.status,
      'source_type', v_version.source_type,
      'source_payload', COALESCE(v_version.source_payload, '{}'::jsonb),
      'normalized_contract', COALESCE(v_version.normalized_contract, '{}'::jsonb),
      'inbound_config', COALESCE(v_version.inbound_config, '{}'::jsonb),
      'mapping_config', COALESCE(v_version.mapping_config, '{}'::jsonb),
      'workflow_binding', COALESCE(v_version.workflow_binding, '{}'::jsonb),
      'outbound_operations', COALESCE(v_version.outbound_operations, '[]'::jsonb),
      'auth_bindings', COALESCE(v_version.auth_bindings, '{}'::jsonb),
      'validation_summary', COALESCE(v_version.validation_summary, '{}'::jsonb),
      'approval_reason', v_version.approval_reason,
      'artifact_hash', v_version.artifact_hash,
      'diff_hash', v_version.diff_hash,
      'metadata', COALESCE(v_version.metadata, '{}'::jsonb)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_marketplace_sync_runtime_auth_config_v1(
  p_connection_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
-- objectives:allow RLS_OFF Justification: runtime auth sync materializes installer-owned secrets into service-only auth rows and must bypass caller RLS in a tightly scoped security definer function.
SET row_security = off
AS $function$
DECLARE
  v_connection public.integration_connections%ROWTYPE;
  v_runtime_id UUID;
BEGIN
  IF p_connection_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_connection
    FROM public.integration_connections
   WHERE id = p_connection_id
   FOR UPDATE;

  IF v_connection.id IS NULL THEN
    RAISE EXCEPTION 'automation_marketplace_sync_runtime_auth_config_v1 connection % not found', p_connection_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_connection.owner_scope_type, v_connection.owner_scope_id, v_connection.organization_id);
  PERFORM public.assert_capability_v1('automation_marketplace.manage_connections',v_connection.owner_scope_type,v_connection.owner_scope_id);
  IF v_connection.status<>'ready' OR v_connection.revoked_at IS NOT NULL OR v_connection.expires_at<=now() THEN
    RAISE EXCEPTION 'Connection is not ready' USING ERRCODE='23514';
  END IF;

  IF v_connection.secret_storage_mode <> 'vault' OR v_connection.credentials_vault_id IS NULL OR v_connection.provider_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_connection.runtime_auth_config_id IS NULL THEN
    INSERT INTO public.provider_auth_configs (
      provider_id,
      auth_type,
      marketplace_explicit_only,
      credentials,
      credentials_vault_id,
      expires_at
    )
    VALUES (
      v_connection.provider_id,
      CASE v_connection.auth_type WHEN 'oauth2_authorization_code_pkce' THEN 'oauth2' WHEN 'hmac_shared_secret' THEN 'hmac' ELSE v_connection.auth_type END,
      TRUE,
      NULL,
      v_connection.credentials_vault_id,
      v_connection.expires_at
    )
    RETURNING id INTO v_runtime_id;

    UPDATE public.integration_connections
       SET runtime_auth_config_id = v_runtime_id,
           updated_at = now()
     WHERE id = v_connection.id;
  ELSE
    UPDATE public.provider_auth_configs
       SET auth_type = CASE v_connection.auth_type WHEN 'oauth2_authorization_code_pkce' THEN 'oauth2' WHEN 'hmac_shared_secret' THEN 'hmac' ELSE v_connection.auth_type END,
           marketplace_explicit_only=TRUE,
           credentials = NULL,
           credentials_vault_id = v_connection.credentials_vault_id,
           expires_at = v_connection.expires_at
     WHERE id = v_connection.runtime_auth_config_id;

    v_runtime_id := v_connection.runtime_auth_config_id;
  END IF;

  RETURN v_runtime_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_create_listing_v1(
  p_asset_kind TEXT,
  p_source_id UUID,
  p_title TEXT DEFAULT NULL,
  p_summary TEXT DEFAULT NULL,
  p_visibility TEXT DEFAULT 'private',
  p_manifest JSONB DEFAULT '{}'::jsonb,
  p_docs JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_notes TEXT DEFAULT NULL,
  p_listing_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_asset_kind TEXT := lower(COALESCE(NULLIF(btrim(p_asset_kind), ''), ''));
  v_source_snapshot_type TEXT;
  v_source_snapshot_id UUID;
  v_snapshot_payload JSONB;
  v_manifest_validation JSONB;
  v_actor_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'tenant');
  v_actor_scope_id UUID := public.current_user_scope_id();
  v_owner_scope_type TEXT := public.normalize_scope_type_v1(v_actor_scope_type, TRUE);
  v_owner_scope_id UUID := v_actor_scope_id;
  v_org_id UUID := public.current_user_org_id();
  v_title TEXT;
  v_summary TEXT := NULLIF(btrim(COALESCE(p_summary, '')), '');
  v_listing_id UUID;
  v_listing_version_id UUID;
  v_existing_listing public.automation_asset_listings%ROWTYPE;
  v_previous_version public.automation_asset_listing_versions%ROWTYPE;
  v_version_no INTEGER:=1;
  v_visibility TEXT := lower(COALESCE(NULLIF(btrim(p_visibility), ''), 'private'));
  v_policy JSONB;
  v_allowed_visibility BOOLEAN := FALSE;
BEGIN
  IF p_source_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_create_listing_v1 requires source_id';
  END IF;

  IF lower(COALESCE(v_actor_scope_type, '')) = 'platform' THEN
    v_owner_scope_type := 'global';
    v_owner_scope_id := NULL;
  ELSIF v_owner_scope_type = 'global' THEN
    v_owner_scope_id := NULL;
  END IF;

  IF v_org_id IS NULL AND v_owner_scope_type <> 'global' THEN
    v_org_id := public.resolve_organization_id_for_scope_v1(v_owner_scope_type, v_owner_scope_id);
  END IF;

  PERFORM public.assert_capability_v1(
    'automation_marketplace.publish',
    v_actor_scope_type,
    v_actor_scope_id
  );

  PERFORM public.automation_marketplace_assert_scope_v1(v_owner_scope_type,v_owner_scope_id,v_org_id);
  IF p_listing_id IS NOT NULL THEN
    SELECT * INTO v_existing_listing FROM public.automation_asset_listings WHERE id=p_listing_id FOR UPDATE;
    IF v_existing_listing.id IS NULL THEN RAISE EXCEPTION 'Listing is unavailable' USING ERRCODE='42501'; END IF;
    PERFORM public.automation_marketplace_assert_scope_v1(v_existing_listing.owner_scope_type,v_existing_listing.owner_scope_id,v_existing_listing.organization_id);
    PERFORM public.assert_capability_v1('automation_marketplace.publish',v_existing_listing.owner_scope_type,v_existing_listing.owner_scope_id);
    IF v_existing_listing.asset_kind IS DISTINCT FROM v_asset_kind THEN RAISE EXCEPTION 'Listing kind cannot change' USING ERRCODE='23514'; END IF;
    SELECT * INTO v_previous_version FROM public.automation_asset_listing_versions WHERE listing_id=p_listing_id ORDER BY listing_version_no DESC LIMIT 1;
    IF v_asset_kind='workflow_template' AND NOT EXISTS(SELECT 1 FROM public.workflow_template_revisions WHERE id=v_previous_version.source_snapshot_id AND workflow_template_id=p_source_id)
      OR v_asset_kind='integration_plugin' AND NOT EXISTS(SELECT 1 FROM public.integration_plugin_versions old_v JOIN public.integration_plugin_versions new_v ON new_v.plugin_id=old_v.plugin_id WHERE old_v.id=v_previous_version.source_snapshot_id AND new_v.id=p_source_id) THEN
      RAISE EXCEPTION 'Listing source identity cannot change' USING ERRCODE='23514';
    END IF;
    v_owner_scope_type:=v_existing_listing.owner_scope_type;
    v_owner_scope_id:=v_existing_listing.owner_scope_id;
    v_org_id:=v_existing_listing.organization_id;
    v_listing_id:=v_existing_listing.id;
    v_version_no:=public.automation_marketplace_next_listing_version_no_v1(v_listing_id);
  END IF;
  PERFORM public.automation_marketplace_assert_secret_free_v1(p_manifest);
  PERFORM public.automation_marketplace_assert_secret_free_v1(p_docs);
  PERFORM public.automation_marketplace_assert_secret_free_v1(p_metadata);

  v_policy := public.automation_marketplace_resolve_policy_v1(v_owner_scope_type, v_owner_scope_id, v_org_id);

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(v_policy #> '{publication,allowed_visibility_modes}', '[]'::jsonb)) AS value
    WHERE lower(value) = v_visibility
  )
    INTO v_allowed_visibility;

  IF v_allowed_visibility IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'automation_asset_create_listing_v1 visibility % is not allowed by policy', v_visibility;
  END IF;

  IF v_asset_kind = 'workflow_template' THEN
    v_source_snapshot_type := 'workflow_template_revision';
    v_source_snapshot_id := public.automation_marketplace_capture_workflow_revision_v1(p_source_id, p_notes);
    SELECT r.snapshot INTO v_snapshot_payload
    FROM public.workflow_template_revisions r
    WHERE r.id = v_source_snapshot_id
    LIMIT 1;

    SELECT COALESCE(NULLIF(btrim(p_title), ''), wt.name)
      INTO v_title
      FROM public.workflow_templates wt
     WHERE wt.id = p_source_id
     LIMIT 1;
  ELSIF v_asset_kind = 'integration_plugin' THEN
    v_source_snapshot_type := 'integration_plugin_version';
    v_source_snapshot_id := p_source_id;
    v_snapshot_payload := public.automation_marketplace_snapshot_integration_plugin_version_v1(p_source_id);

    SELECT COALESCE(NULLIF(btrim(p_title), ''), p.name)
      INTO v_title
      FROM public.integration_plugin_versions v
      JOIN public.integration_plugins p ON p.id = v.plugin_id
     WHERE v.id = p_source_id
     LIMIT 1;
  ELSE
    RAISE EXCEPTION 'automation_asset_create_listing_v1 unsupported asset_kind=%', p_asset_kind;
  END IF;

  IF v_title IS NULL OR btrim(v_title) = '' THEN
    RAISE EXCEPTION 'automation_asset_create_listing_v1 could not resolve listing title';
  END IF;

  PERFORM public.automation_marketplace_assert_secret_free_v1(v_snapshot_payload);

  v_manifest_validation := public.automation_marketplace_validate_manifest_v1(
    jsonb_set(COALESCE(p_manifest, '{}'::jsonb), '{artifact_hash}', to_jsonb(public.automation_marketplace_hash_payload_v1(v_snapshot_payload)), true),
    v_snapshot_payload
  );

  IF COALESCE((v_manifest_validation->>'ok')::boolean, FALSE) = FALSE THEN
    RAISE EXCEPTION 'automation_asset_create_listing_v1 manifest validation failed: %', v_manifest_validation->'errors';
  END IF;

  IF p_listing_id IS NULL THEN
  INSERT INTO public.automation_asset_listings (
    organization_id,
    owner_scope_type,
    owner_scope_id,
    asset_kind,
    title,
    summary,
    visibility,
    publication_status,
    metadata,
    created_by,
    updated_by
  )
  VALUES (
    v_org_id,
    v_owner_scope_type,
    v_owner_scope_id,
    v_asset_kind,
    v_title,
    v_summary,
    v_visibility,
    'draft',
    COALESCE(p_metadata, '{}'::jsonb),
    auth.uid(),
    auth.uid()
  )
  RETURNING id INTO v_listing_id;
  END IF;

  INSERT INTO public.automation_asset_listing_versions (
    listing_id,
    organization_id,
    asset_kind,
    listing_version_no,
    visibility,
    publication_status,
    source_snapshot_type,
    source_snapshot_id,
    manifest,
    snapshot_payload,
    docs,
    compatibility,
    egress_profile,
    artifact_hash,
    created_by
  )
  VALUES (
    v_listing_id,
    v_org_id,
    v_asset_kind,
    v_version_no,
    v_visibility,
    'draft',
    v_source_snapshot_type,
    v_source_snapshot_id,
    jsonb_set(COALESCE(p_manifest, '{}'::jsonb), '{artifact_hash}', to_jsonb(public.automation_marketplace_hash_payload_v1(v_snapshot_payload)), true),
    v_snapshot_payload,
    COALESCE(p_docs, '{}'::jsonb),
    COALESCE(p_manifest->'compatibility', '{}'::jsonb),
    COALESCE(p_manifest->'egress_profile', '{}'::jsonb),
    public.automation_marketplace_hash_payload_v1(v_snapshot_payload),
    auth.uid()
  )
  RETURNING id INTO v_listing_version_id;

  IF p_listing_id IS NULL OR v_existing_listing.publication_status<>'approved' THEN
  UPDATE public.automation_asset_listings
     SET latest_listing_version_id = v_listing_version_id,
         publication_status='draft',
         visibility=v_visibility,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_listing_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'listing_id', v_listing_id,
    'listing_version_id', v_listing_version_id,
    'asset_kind', v_asset_kind,
    'visibility', v_visibility
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_publish_version_v1(
  p_listing_version_id UUID,
  p_visibility TEXT DEFAULT 'private'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_version public.automation_asset_listing_versions%ROWTYPE;
  v_listing public.automation_asset_listings%ROWTYPE;
  v_visibility TEXT := lower(COALESCE(NULLIF(btrim(p_visibility), ''), 'private'));
  v_policy JSONB;
  v_allowed BOOLEAN := FALSE;
  v_public_review_required BOOLEAN := TRUE;
BEGIN
  IF p_listing_version_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_publish_version_v1 requires listing_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.automation_asset_listing_versions
  WHERE id = p_listing_version_id
  FOR UPDATE;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_publish_version_v1 listing version % not found', p_listing_version_id;
  END IF;

  SELECT * INTO v_listing
  FROM public.automation_asset_listings
  WHERE id = v_version.listing_id
  FOR UPDATE;

  PERFORM public.automation_marketplace_assert_scope_v1(v_listing.owner_scope_type, v_listing.owner_scope_id, v_listing.organization_id);
  PERFORM public.assert_capability_v1('automation_marketplace.publish', v_listing.owner_scope_type, v_listing.owner_scope_id);

  IF v_version.publication_status NOT IN ('draft','rejected') THEN
    RAISE EXCEPTION 'Listing version is not editable' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.automation_asset_listing_versions current_v WHERE current_v.id=v_listing.latest_listing_version_id AND current_v.publication_status='approved' AND current_v.listing_version_no>v_version.listing_version_no) THEN
    RAISE EXCEPTION 'An older version cannot replace the approved current version' USING ERRCODE='23514';
  END IF;
  v_policy := public.automation_marketplace_resolve_policy_v1(v_listing.owner_scope_type, v_listing.owner_scope_id, v_listing.organization_id);

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(v_policy #> '{publication,allowed_visibility_modes}', '[]'::jsonb)) AS value
    WHERE lower(value) = v_visibility
  )
    INTO v_allowed;

  IF v_allowed IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'automation_asset_publish_version_v1 visibility % is not allowed by policy', v_visibility;
  END IF;

  v_public_review_required := COALESCE((v_policy #>> '{publication,public_review_required}')::boolean, TRUE);

  IF v_visibility = 'marketplace_public' THEN
    RAISE EXCEPTION 'automation_asset_publish_version_v1 marketplace_public requires review submission';
  END IF;

  UPDATE public.automation_asset_listings
     SET visibility = v_visibility,
         publication_status = 'approved',
         latest_listing_version_id = v_version.id,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_listing.id;

  UPDATE public.automation_asset_listing_versions
     SET visibility = v_visibility,
         publication_status = 'approved',
         approved_at = CASE WHEN v_visibility <> 'marketplace_public' THEN now() ELSE approved_at END,
         approved_by = CASE WHEN v_visibility <> 'marketplace_public' THEN auth.uid() ELSE approved_by END,
         updated_at = now()
   WHERE id = v_version.id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'listing_id', v_listing.id,
    'listing_version_id', v_version.id,
    'visibility', v_visibility,
    'publication_status', 'approved'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_submit_review_v1(
  p_listing_version_id UUID,
  p_submission_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_version public.automation_asset_listing_versions%ROWTYPE;
  v_listing public.automation_asset_listings%ROWTYPE;
  v_policy JSONB;
  v_allow_sender_public_publish BOOLEAN := FALSE;
  v_review_id UUID;
BEGIN
  IF p_listing_version_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_submit_review_v1 requires listing_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.automation_asset_listing_versions
  WHERE id = p_listing_version_id
  FOR UPDATE;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_submit_review_v1 listing version % not found', p_listing_version_id;
  END IF;

  SELECT * INTO v_listing
  FROM public.automation_asset_listings
  WHERE id = v_version.listing_id
  FOR UPDATE;

  PERFORM public.automation_marketplace_assert_scope_v1(v_listing.owner_scope_type, v_listing.owner_scope_id, v_listing.organization_id);
  PERFORM public.assert_capability_v1('automation_marketplace.publish', v_listing.owner_scope_type, v_listing.owner_scope_id);

  IF v_version.publication_status NOT IN ('draft','rejected') THEN
    RAISE EXCEPTION 'Listing version is not editable' USING ERRCODE='23514';
  END IF;
  v_policy := public.automation_marketplace_resolve_policy_v1(v_listing.owner_scope_type, v_listing.owner_scope_id, v_listing.organization_id);
  v_allow_sender_public_publish := COALESCE((v_policy #>> '{publication,allow_sender_public_publish}')::boolean, FALSE);

  IF v_listing.owner_scope_type = 'sender' AND v_allow_sender_public_publish = FALSE THEN
    RAISE EXCEPTION 'automation_asset_submit_review_v1 sender public publishing is disabled by policy';
  END IF;

  INSERT INTO public.automation_asset_reviews (
    listing_version_id,
    organization_id,
    review_status,
    submission_notes,
    created_by
  )
  VALUES (
    v_version.id,
    v_version.organization_id,
    'pending',
    NULLIF(btrim(COALESCE(p_submission_notes, '')), ''),
    auth.uid()
  )
  RETURNING id INTO v_review_id;

  -- Keep an existing approved catalogue version live while its replacement is reviewed.
  IF v_listing.publication_status<>'approved' THEN
  UPDATE public.automation_asset_listings
     SET visibility = 'marketplace_public',
         publication_status = 'submitted',
         latest_listing_version_id = v_version.id,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_listing.id;
  END IF;

  UPDATE public.automation_asset_listing_versions
     SET visibility = 'marketplace_public',
         publication_status = 'submitted',
         submitted_at = now(),
         updated_at = now()
   WHERE id = v_version.id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'review_id', v_review_id,
    'listing_version_id', v_version.id,
    'publication_status', 'submitted'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_review_decide_v1(
  p_review_id UUID,
  p_decision TEXT,
  p_decision_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_review public.automation_asset_reviews%ROWTYPE;
  v_version public.automation_asset_listing_versions%ROWTYPE;
  v_listing public.automation_asset_listings%ROWTYPE;
  v_decision TEXT := lower(COALESCE(NULLIF(btrim(p_decision), ''), ''));
BEGIN
  IF p_review_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_review_decide_v1 requires review_id';
  END IF;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'automation_asset_review_decide_v1 decision must be approved or rejected';
  END IF;

  SELECT * INTO v_review
  FROM public.automation_asset_reviews
  WHERE id = p_review_id
  FOR UPDATE;

  IF v_review.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_review_decide_v1 review % not found', p_review_id;
  END IF;

  SELECT * INTO v_version
  FROM public.automation_asset_listing_versions
  WHERE id = v_review.listing_version_id
  FOR UPDATE;

  SELECT * INTO v_listing
  FROM public.automation_asset_listings
  WHERE id = v_version.listing_id
  FOR UPDATE;

  IF NOT public.request_role_is_service_v1() AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'Global marketplace reviewer required' USING ERRCODE='42501';
  END IF;
  IF v_review.review_status<>'pending' OR v_version.publication_status<>'submitted' THEN
    RAISE EXCEPTION 'Review is not pending' USING ERRCODE='23514';
  END IF;
  IF v_decision='approved' AND EXISTS(SELECT 1 FROM public.automation_asset_listing_versions current_v WHERE current_v.id=v_listing.latest_listing_version_id AND current_v.publication_status='approved' AND current_v.listing_version_no>v_version.listing_version_no) THEN
    RAISE EXCEPTION 'An older review cannot replace the approved current version' USING ERRCODE='23514';
  END IF;
  PERFORM public.assert_capability_v1('automation_marketplace.review', 'global', NULL);

  UPDATE public.automation_asset_reviews
     SET review_status = v_decision,
         reviewer_user_id = auth.uid(),
         decision_notes = NULLIF(btrim(COALESCE(p_decision_notes, '')), ''),
         reviewed_at = now(),
         updated_at = now()
   WHERE id = v_review.id;

  UPDATE public.automation_asset_listing_versions
     SET publication_status = CASE WHEN v_decision = 'approved' THEN 'approved' ELSE 'rejected' END,
         approved_at = CASE WHEN v_decision = 'approved' THEN now() ELSE approved_at END,
         approved_by = CASE WHEN v_decision = 'approved' THEN auth.uid() ELSE approved_by END,
         updated_at = now()
   WHERE id = v_version.id;

  IF v_decision='approved' OR v_listing.publication_status<>'approved' THEN
  UPDATE public.automation_asset_listings
     SET publication_status = CASE WHEN v_decision = 'approved' THEN 'approved' ELSE 'rejected' END,
         visibility=CASE WHEN v_decision='approved' THEN v_version.visibility ELSE visibility END,
         latest_listing_version_id = v_version.id,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_listing.id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'review_id', v_review.id,
    'listing_version_id', v_version.id,
    'decision', v_decision
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_connection_upsert_v1(
  p_connection_id UUID DEFAULT NULL,
  p_owner_scope_type TEXT DEFAULT NULL,
  p_owner_scope_id UUID DEFAULT NULL,
  p_provider_id UUID DEFAULT NULL,
  p_provider_key TEXT DEFAULT NULL,
  p_name TEXT DEFAULT NULL,
  p_auth_type TEXT DEFAULT NULL,
  p_config JSONB DEFAULT NULL,
  p_oauth_metadata JSONB DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL,
  p_secret_payload JSONB DEFAULT NULL,
  p_secret_storage_mode TEXT DEFAULT NULL,
  p_generate_secret BOOLEAN DEFAULT FALSE,
  p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_connection public.integration_connections%ROWTYPE;
  v_owner_scope_type TEXT := COALESCE(NULLIF(btrim(COALESCE(p_owner_scope_type, '')), ''), public.current_user_scope_type(), 'tenant');
  v_owner_scope_id UUID := COALESCE(p_owner_scope_id, public.current_user_scope_id(), public.current_user_org_id());
  v_provider_key TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(p_provider_key, '')), ''), 'custom'));
  v_name TEXT := COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), initcap(replace(v_provider_key, '_', ' ')));
  v_auth_type TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(p_auth_type, '')), ''), 'api_key'));
  v_storage_mode TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(p_secret_storage_mode, '')), ''), 'vault'));
  v_org_id UUID;
  v_policy JSONB;
  v_generated_secret TEXT := NULL;
  v_secret_payload JSONB := p_secret_payload;
  v_secret_text TEXT;
  v_vault_id UUID;
BEGIN
  IF p_connection_id IS NOT NULL THEN
    SELECT * INTO v_connection
    FROM public.integration_connections
    WHERE id = p_connection_id
    FOR UPDATE;

    IF v_connection.id IS NULL THEN
      RAISE EXCEPTION 'integration_connection_upsert_v1 connection % not found', p_connection_id;
    END IF;
  END IF;

  IF v_connection.id IS NOT NULL THEN
    PERFORM public.automation_marketplace_assert_scope_v1(v_connection.owner_scope_type,v_connection.owner_scope_id,v_connection.organization_id);
    PERFORM public.assert_capability_v1('automation_marketplace.manage_connections',v_connection.owner_scope_type,v_connection.owner_scope_id);
    IF v_connection.status='revoked' OR v_connection.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Connection is revoked' USING ERRCODE='23514';
    END IF;
    v_owner_scope_type:=COALESCE(NULLIF(btrim(p_owner_scope_type),''),v_connection.owner_scope_type);
    v_owner_scope_id:=COALESCE(p_owner_scope_id,v_connection.owner_scope_id);
    v_provider_key:=COALESCE(NULLIF(lower(btrim(p_provider_key)),''),v_connection.provider_key);
    v_auth_type:=COALESCE(NULLIF(lower(btrim(p_auth_type)),''),v_connection.auth_type);
    v_name:=COALESCE(NULLIF(btrim(p_name),''),v_connection.name);
    v_storage_mode:=COALESCE(NULLIF(lower(btrim(p_secret_storage_mode)),''),v_connection.secret_storage_mode);
  END IF;
  v_owner_scope_type:=public.normalize_scope_type_v1(v_owner_scope_type,TRUE);
  PERFORM public.automation_marketplace_assert_scope_v1(v_owner_scope_type,v_owner_scope_id);
  PERFORM public.automation_marketplace_assert_secret_free_v1(p_config);
  PERFORM public.automation_marketplace_assert_secret_free_v1(p_oauth_metadata);
  PERFORM public.automation_marketplace_assert_secret_free_v1(p_metadata);
  IF EXISTS(SELECT 1 FROM public.automation_asset_install_bindings b JOIN public.automation_asset_installs i ON i.id=b.install_id
    WHERE b.connection_id=v_connection.id AND (i.target_scope_type IS DISTINCT FROM v_owner_scope_type OR i.target_scope_id IS DISTINCT FROM v_owner_scope_id)) THEN
    RAISE EXCEPTION 'Bound connection cannot move outside its install scope' USING ERRCODE='23514';
  END IF;
  IF COALESCE(p_provider_id,v_connection.provider_id) IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.providers p WHERE p.id=COALESCE(p_provider_id,v_connection.provider_id)
      AND p.organization_id=public.resolve_organization_id_for_scope_v1(v_owner_scope_type,v_owner_scope_id) AND p.enabled
  ) THEN RAISE EXCEPTION 'Connection provider is outside target scope or disabled' USING ERRCODE='42501'; END IF;
  PERFORM public.assert_capability_v1('automation_marketplace.manage_connections', v_owner_scope_type, v_owner_scope_id);

  IF v_owner_scope_id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_upsert_v1 requires owner scope';
  END IF;

  v_org_id := public.resolve_organization_id_for_scope_v1(v_owner_scope_type, v_owner_scope_id);
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_upsert_v1 unable to resolve organization for scope %/%', v_owner_scope_type, v_owner_scope_id;
  END IF;

  v_policy := public.automation_marketplace_resolve_policy_v1(v_owner_scope_type, v_owner_scope_id, v_org_id);

  IF p_generate_secret AND v_secret_payload IS NULL THEN
    v_generated_secret := encode(gen_random_bytes(24), 'hex');
    v_secret_payload := jsonb_build_object('secret', v_generated_secret);
  END IF;

  v_secret_text := public.automation_marketplace_secret_text_v1(v_secret_payload);

  IF v_storage_mode = 'hash_only' THEN
    IF v_secret_text IS NULL AND p_connection_id IS NULL THEN
      RAISE EXCEPTION 'integration_connection_upsert_v1 hash_only connections require a verifier secret';
    END IF;
  ELSE
    IF COALESCE((v_policy #>> '{secrets,vault_required}')::boolean, TRUE) = TRUE THEN
      v_storage_mode := 'vault';
    END IF;
  END IF;

  IF p_connection_id IS NULL THEN
    IF v_storage_mode = 'vault' AND v_secret_payload IS NOT NULL THEN
      v_vault_id := public.automation_marketplace_store_secret_payload_v1(NULL, v_secret_payload);
    END IF;

    INSERT INTO public.integration_connections (
      organization_id,
      owner_scope_type,
      owner_scope_id,
      provider_id,
      provider_key,
      name,
      auth_type,
      status,
      secret_storage_mode,
      credentials_vault_id,
      verifier_secret_hash,
      secret_hint,
      config,
      oauth_metadata,
      metadata,
      expires_at,
      last_rotated_at,
      created_by,
      updated_by
    )
    VALUES (
      v_org_id,
      v_owner_scope_type,
      v_owner_scope_id,
      p_provider_id,
      v_provider_key,
      v_name,
      v_auth_type,
      CASE WHEN v_secret_payload IS NULL AND v_storage_mode = 'vault' THEN 'draft' ELSE 'ready' END,
      v_storage_mode,
      v_vault_id,
      CASE WHEN v_storage_mode = 'hash_only' THEN public.automation_marketplace_secret_hash_v1(v_secret_text) ELSE NULL END,
      CASE WHEN v_secret_text IS NOT NULL THEN public.automation_marketplace_secret_hint_v1(v_secret_text) ELSE NULL END,
      COALESCE(p_config, '{}'::jsonb),
      COALESCE(p_oauth_metadata, '{}'::jsonb),
      COALESCE(p_metadata, '{}'::jsonb),
      p_expires_at,
      CASE WHEN v_secret_payload IS NOT NULL THEN now() ELSE NULL END,
      auth.uid(),
      auth.uid()
    )
    RETURNING * INTO v_connection;
  ELSE
    v_vault_id := v_connection.credentials_vault_id;
    IF v_connection.runtime_auth_config_id IS NOT NULL AND COALESCE(p_provider_id,v_connection.provider_id) IS DISTINCT FROM v_connection.provider_id THEN
      UPDATE public.provider_auth_configs SET credentials='{}'::jsonb,credentials_vault_id=NULL,expires_at=now()
        WHERE id=v_connection.runtime_auth_config_id AND provider_id=v_connection.provider_id;
    END IF;
    IF v_storage_mode = 'vault' AND v_secret_payload IS NOT NULL THEN
      v_vault_id := public.automation_marketplace_store_secret_payload_v1(v_connection.credentials_vault_id, v_secret_payload);
    END IF;

    UPDATE public.integration_connections
       SET owner_scope_type = v_owner_scope_type,
           owner_scope_id = v_owner_scope_id,
           organization_id = v_org_id,
           provider_id = COALESCE(p_provider_id, provider_id),
           runtime_auth_config_id=CASE WHEN COALESCE(p_provider_id,provider_id) IS DISTINCT FROM provider_id THEN NULL ELSE runtime_auth_config_id END,
           provider_key = v_provider_key,
           name = v_name,
           auth_type = v_auth_type,
           status = CASE
             WHEN v_storage_mode='hash_only' AND v_secret_text IS NULL AND verifier_secret_hash IS NULL THEN 'draft'
             WHEN v_storage_mode = 'vault' AND v_secret_payload IS NULL AND credentials_vault_id IS NULL THEN 'draft'
             WHEN v_secret_payload IS NULL THEN status
             ELSE 'ready'
           END,
           secret_storage_mode = v_storage_mode,
           credentials_vault_id = CASE WHEN v_storage_mode = 'vault' THEN v_vault_id ELSE NULL END,
           verifier_secret_hash = CASE WHEN v_storage_mode = 'hash_only' AND v_secret_text IS NOT NULL THEN public.automation_marketplace_secret_hash_v1(v_secret_text) ELSE CASE WHEN v_storage_mode = 'hash_only' THEN verifier_secret_hash ELSE NULL END END,
           secret_hint = CASE WHEN v_secret_text IS NOT NULL THEN public.automation_marketplace_secret_hint_v1(v_secret_text) ELSE secret_hint END,
           config = COALESCE(p_config, config),
           oauth_metadata = COALESCE(p_oauth_metadata, oauth_metadata),
           metadata = COALESCE(p_metadata, metadata),
           expires_at = COALESCE(p_expires_at, expires_at),
           credential_generation = credential_generation + CASE WHEN v_secret_payload IS NOT NULL
             OR v_owner_scope_type IS DISTINCT FROM owner_scope_type OR v_owner_scope_id IS DISTINCT FROM owner_scope_id
             OR COALESCE(p_provider_id,provider_id) IS DISTINCT FROM provider_id OR v_provider_key IS DISTINCT FROM provider_key
             OR v_auth_type IS DISTINCT FROM auth_type OR v_storage_mode IS DISTINCT FROM secret_storage_mode
             OR (p_config IS NOT NULL AND p_config IS DISTINCT FROM config)
             OR (p_expires_at IS NOT NULL AND p_expires_at IS DISTINCT FROM expires_at) THEN 1 ELSE 0 END,
           last_rotated_at = CASE WHEN v_secret_payload IS NOT NULL THEN now() ELSE last_rotated_at END,
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = p_connection_id
     RETURNING * INTO v_connection;
  END IF;

  IF v_connection.status='ready' AND v_connection.expires_at IS DISTINCT FROM '-infinity'::timestamptz AND (v_connection.expires_at IS NULL OR v_connection.expires_at>now()) AND v_connection.secret_storage_mode = 'vault' AND v_connection.credentials_vault_id IS NOT NULL AND v_connection.provider_id IS NOT NULL THEN
    PERFORM public.automation_marketplace_sync_runtime_auth_config_v1(v_connection.id);
    SELECT * INTO v_connection FROM public.integration_connections WHERE id = v_connection.id;
  ELSIF v_connection.runtime_auth_config_id IS NOT NULL THEN
    UPDATE public.provider_auth_configs SET credentials='{}'::jsonb,credentials_vault_id=NULL,expires_at=now()
      WHERE id=v_connection.runtime_auth_config_id AND provider_id=v_connection.provider_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'connection_id', v_connection.id,
    'status', v_connection.status,
    'secret_hint', v_connection.secret_hint,
    'generated_secret', v_generated_secret
  );
END;
$function$;

CREATE FUNCTION public.automation_marketplace_has_secret_material_v1(p_value JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $function$
DECLARE entry JSONB;
BEGIN
 IF jsonb_typeof(p_value)='string' THEN RETURN btrim(p_value #>> '{}')<>''; END IF;
 IF jsonb_typeof(p_value)='object' THEN
  FOR entry IN SELECT value FROM jsonb_each(p_value) LOOP
   IF public.automation_marketplace_has_secret_material_v1(entry) THEN RETURN TRUE; END IF;
  END LOOP;
 ELSIF jsonb_typeof(p_value)='array' THEN
  FOR entry IN SELECT value FROM jsonb_array_elements(p_value) LOOP
   IF public.automation_marketplace_has_secret_material_v1(entry) THEN RETURN TRUE; END IF;
  END LOOP;
 END IF;
 RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_connection_test_v1(
  p_connection_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_connection public.integration_connections%ROWTYPE;
  v_status TEXT;
  v_runtime_auth_config_id UUID;
  v_secret TEXT;
  v_material BOOLEAN:=FALSE;
BEGIN
  IF p_connection_id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_test_v1 requires connection_id';
  END IF;

  SELECT * INTO v_connection
  FROM public.integration_connections
  WHERE id = p_connection_id
  FOR UPDATE;

  IF v_connection.id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_test_v1 connection % not found', p_connection_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_connection.owner_scope_type, v_connection.owner_scope_id, v_connection.organization_id);
  IF v_connection.status='revoked' OR v_connection.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Connection is revoked' USING ERRCODE='23514';
  END IF;

  PERFORM public.assert_capability_v1('automation_marketplace.manage_connections', v_connection.owner_scope_type, v_connection.owner_scope_id);

  IF v_connection.secret_storage_mode='vault' AND v_connection.credentials_vault_id IS NOT NULL THEN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE id=v_connection.credentials_vault_id;
    BEGIN
      v_material:=public.automation_marketplace_has_secret_material_v1(v_secret::jsonb);
    EXCEPTION WHEN invalid_text_representation THEN v_material:=FALSE;
    END;
  END IF;
  IF v_connection.status='disabled' THEN
    v_status:='disabled';
  ELSIF v_connection.expires_at <= now() THEN
    v_status := 'reauth_required';
  ELSIF v_connection.secret_storage_mode = 'vault' AND NOT v_material THEN
    v_status := 'test_failed';
  ELSIF v_connection.secret_storage_mode = 'hash_only' AND v_connection.verifier_secret_hash IS NULL THEN
    v_status := 'test_failed';
  ELSE
    v_status := 'ready';
  END IF;

  UPDATE public.integration_connections
     SET status = v_status,
         last_tested_at = now(),
         last_tested_credential_generation=CASE WHEN v_status='ready' THEN credential_generation ELSE NULL END,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_connection.id;

  IF v_status = 'ready' THEN
    v_runtime_auth_config_id := public.automation_marketplace_sync_runtime_auth_config_v1(v_connection.id);
  END IF;

  RETURN jsonb_build_object(
    'ok', v_status = 'ready',
    'connection_id', v_connection.id,
    'status', v_status,
    'test_kind', 'credential_presence',
    'remote_verified', FALSE,
    'credential_generation',v_connection.credential_generation,
    'last_tested_credential_generation',CASE WHEN v_status='ready' THEN v_connection.credential_generation ELSE NULL END,
    'runtime_auth_config_id', v_runtime_auth_config_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_connection_rotate_v1(
  p_connection_id UUID,
  p_secret_payload JSONB DEFAULT NULL,
  p_generate_secret BOOLEAN DEFAULT FALSE,
  p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_connection public.integration_connections%ROWTYPE;
BEGIN
  IF p_connection_id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_rotate_v1 requires connection_id';
  END IF;

  SELECT * INTO v_connection
  FROM public.integration_connections
  WHERE id = p_connection_id
  FOR UPDATE;

  IF v_connection.id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_rotate_v1 connection % not found', p_connection_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_connection.owner_scope_type, v_connection.owner_scope_id, v_connection.organization_id);
  IF v_connection.status='revoked' OR v_connection.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Connection is revoked' USING ERRCODE='23514';
  END IF;

  RETURN public.integration_connection_upsert_v1(
    p_connection_id,
    v_connection.owner_scope_type,
    v_connection.owner_scope_id,
    v_connection.provider_id,
    v_connection.provider_key,
    v_connection.name,
    v_connection.auth_type,
    v_connection.config,
    v_connection.oauth_metadata,
    v_connection.metadata,
    p_secret_payload,
    v_connection.secret_storage_mode,
    p_generate_secret,
    COALESCE(p_expires_at, v_connection.expires_at)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_connection_revoke_v1(
  p_connection_id UUID,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_connection public.integration_connections%ROWTYPE;
  v_notes TEXT := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
  IF p_connection_id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_revoke_v1 requires connection_id';
  END IF;

  SELECT *
    INTO v_connection
    FROM public.integration_connections
   WHERE id = p_connection_id
   FOR UPDATE;

  IF v_connection.id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_revoke_v1 connection % not found', p_connection_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_connection.owner_scope_type, v_connection.owner_scope_id, v_connection.organization_id);
  IF v_connection.status='revoked' OR v_connection.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Connection is revoked' USING ERRCODE='23514';
  END IF;

  PERFORM public.assert_capability_v1(
    'automation_marketplace.manage_connections',
    v_connection.owner_scope_type,
    v_connection.owner_scope_id
  );

  IF v_connection.runtime_auth_config_id IS NOT NULL THEN
    UPDATE public.provider_auth_configs SET credentials='{}'::jsonb,credentials_vault_id=NULL,expires_at=now()
      WHERE id=v_connection.runtime_auth_config_id AND provider_id=v_connection.provider_id;
  END IF;

  UPDATE public.integration_connections
     SET status = 'revoked',
         credential_generation=credential_generation+1,
         revoked_at = now(),
         metadata = CASE
           WHEN v_notes IS NULL THEN COALESCE(metadata, '{}'::jsonb)
           ELSE jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{revoke_notes}',
             to_jsonb(v_notes),
             true
           )
         END,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_connection.id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'connection_id', v_connection.id,
    'status', 'revoked'
  );
END;
$function$;

CREATE FUNCTION public.automation_marketplace_connection_for_install_v1(
 p_connection_id UUID,p_scope_type TEXT,p_scope_id UUID,p_org UUID,p_manifest JSONB,p_binding_key TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE connection public.integration_connections%ROWTYPE; policy JSONB; requirement JSONB;
BEGIN
 PERFORM public.automation_marketplace_assert_scope_v1(p_scope_type,p_scope_id,p_org);
 IF NOT p_binding_key=ANY(public.automation_marketplace_manifest_keys_v1(p_manifest,'connections')) THEN
  RAISE EXCEPTION 'Binding key is not declared in manifest' USING ERRCODE='23514';
 END IF;
 SELECT * INTO connection FROM public.integration_connections WHERE id=p_connection_id FOR UPDATE;
 IF connection.id IS NULL THEN RAISE EXCEPTION 'Connection is unavailable' USING ERRCODE='23514'; END IF;
 PERFORM public.automation_marketplace_assert_scope_v1(connection.owner_scope_type,connection.owner_scope_id,connection.organization_id);
 PERFORM public.assert_capability_v1('automation_marketplace.manage_connections',connection.owner_scope_type,connection.owner_scope_id);
 IF connection.organization_id IS DISTINCT FROM p_org OR connection.status<>'ready'
    OR connection.revoked_at IS NOT NULL OR connection.expires_at<=now() THEN
  RAISE EXCEPTION 'Connection is not ready in target organization' USING ERRCODE='23514';
 END IF;
 policy:=public.automation_marketplace_resolve_policy_v1(p_scope_type,p_scope_id,p_org);
 IF NOT COALESCE((policy #>> '{connections,allow_cross_scope_reuse}')::boolean,FALSE)
    OR COALESCE(policy #>> '{connections,reuse_mode}','scope_local')='scope_local' THEN
  IF connection.owner_scope_type IS DISTINCT FROM p_scope_type OR connection.owner_scope_id IS DISTINCT FROM p_scope_id THEN
   RAISE EXCEPTION 'Connection reuse is restricted to the install scope by policy' USING ERRCODE='23514';
  END IF;
 END IF;
 requirement:=p_manifest #> ARRAY['connection_requirements',p_binding_key];
 IF requirement IS NULL AND jsonb_typeof(p_manifest #> '{connection_requirements,bindings}')='array' THEN
  SELECT binding INTO requirement FROM jsonb_array_elements(p_manifest #> '{connection_requirements,bindings}') binding
   WHERE binding->>'key'=p_binding_key LIMIT 1;
 END IF;
 IF jsonb_typeof(requirement->'auth_types')='array' AND NOT (requirement->'auth_types' ? connection.auth_type) THEN
  RAISE EXCEPTION 'Connection auth type is not allowed by the manifest' USING ERRCODE='23514';
 END IF;
 RETURN public.automation_marketplace_sync_runtime_auth_config_v1(connection.id);
END;
$function$;


CREATE FUNCTION public.automation_marketplace_bind_install_initial_v1(
  p_install_id UUID,
  p_binding_key TEXT,
  p_connection_id UUID,
  p_binding_type TEXT DEFAULT 'connection',
  p_config JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_install public.automation_asset_installs%ROWTYPE;
  v_connection public.integration_connections%ROWTYPE;
  v_runtime_auth_config_id UUID;
  v_binding_id UUID;
BEGIN
  IF p_install_id IS NULL OR p_connection_id IS NULL OR p_binding_key IS NULL OR btrim(p_binding_key) = '' THEN
    RAISE EXCEPTION 'integration_connection_bind_install_v1 requires install_id, binding_key, and connection_id';
  END IF;

  SELECT * INTO v_install
  FROM public.automation_asset_installs
  WHERE id = p_install_id
  FOR UPDATE;

  IF v_install.id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_bind_install_v1 install % not found', p_install_id;
  END IF;

  SELECT * INTO v_connection
  FROM public.integration_connections
  WHERE id = p_connection_id
  FOR UPDATE;

  IF v_connection.id IS NULL THEN
    RAISE EXCEPTION 'integration_connection_bind_install_v1 connection % not found', p_connection_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_install.target_scope_type, v_install.target_scope_id, v_install.organization_id);
  IF v_install.install_status='revoked' THEN RAISE EXCEPTION 'Install is revoked' USING ERRCODE='23514'; END IF;

  PERFORM public.assert_capability_v1('automation_marketplace.install', v_install.target_scope_type, v_install.target_scope_id);

  IF EXISTS(SELECT 1 FROM public.automation_asset_install_bindings b JOIN public.integration_connections c ON c.id=b.connection_id
    WHERE b.install_id=v_install.id AND b.binding_key=btrim(p_binding_key)
      AND NOT public.automation_marketplace_current_scope_can_manage_target_v1(c.owner_scope_type,c.owner_scope_id)) THEN
    RAISE EXCEPTION 'Existing connection binding is outside actor scope' USING ERRCODE='42501';
  END IF;
  PERFORM public.automation_marketplace_assert_secret_free_v1(p_config);
  v_runtime_auth_config_id:=public.automation_marketplace_connection_for_install_v1(
    v_connection.id,v_install.target_scope_type,v_install.target_scope_id,v_install.organization_id,
    (SELECT manifest FROM public.automation_asset_listing_versions WHERE id=v_install.current_listing_version_id),btrim(p_binding_key));

  INSERT INTO public.automation_asset_install_bindings (
    install_id,
    binding_key,
    binding_type,
    connection_id,
    runtime_resource_type,
    runtime_resource_id,
    config,
    created_by
  )
  VALUES (
    v_install.id,
    btrim(p_binding_key),
    lower(COALESCE(NULLIF(btrim(p_binding_type), ''), 'connection')),
    v_connection.id,
    CASE WHEN v_runtime_auth_config_id IS NULL THEN NULL ELSE 'provider_auth_configs' END,
    v_runtime_auth_config_id,
    COALESCE(p_config, '{}'::jsonb),
    auth.uid()
  )
  ON CONFLICT (install_id, binding_key)
  DO UPDATE SET
    binding_type = EXCLUDED.binding_type,
    connection_id = EXCLUDED.connection_id,
    runtime_resource_type = EXCLUDED.runtime_resource_type,
    runtime_resource_id = EXCLUDED.runtime_resource_id,
    config = EXCLUDED.config,
    updated_at = now()
  RETURNING id INTO v_binding_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'binding_id', v_binding_id,
    'install_id', v_install.id,
    'connection_id', v_connection.id,
    'runtime_auth_config_id', v_runtime_auth_config_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_connection_bind_install_v1(
 p_install_id UUID,p_binding_key TEXT,p_connection_id UUID,p_binding_type TEXT DEFAULT 'connection',p_config JSONB DEFAULT '{}')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp SET row_security=on AS $function$
DECLARE install public.automation_asset_installs%ROWTYPE; binding public.automation_asset_install_bindings%ROWTYPE;
 connection public.integration_connections%ROWTYPE; runtime_id UUID;
BEGIN
 SELECT * INTO install FROM public.automation_asset_installs WHERE id=p_install_id FOR UPDATE;
 IF install.id IS NULL THEN RAISE EXCEPTION 'Install is unavailable' USING ERRCODE='42501'; END IF;
 PERFORM public.automation_marketplace_assert_scope_v1(install.target_scope_type,install.target_scope_id,install.organization_id);
 PERFORM public.assert_capability_v1('automation_marketplace.install',install.target_scope_type,install.target_scope_id);
 IF install.install_status='revoked' THEN RAISE EXCEPTION 'Install is revoked' USING ERRCODE='23514'; END IF;
 SELECT * INTO binding FROM public.automation_asset_install_bindings WHERE install_id=install.id AND binding_key=btrim(p_binding_key) FOR UPDATE;
 IF binding.id IS NULL OR binding.connection_id IS DISTINCT FROM p_connection_id
    OR binding.binding_type IS DISTINCT FROM lower(COALESCE(NULLIF(btrim(p_binding_type),''),'connection'))
    OR binding.config IS DISTINCT FROM COALESCE(p_config,'{}') THEN
  RAISE EXCEPTION 'Materialized install bindings cannot change; create a fresh copy with the required bindings' USING ERRCODE='23514';
 END IF;
 SELECT * INTO connection FROM public.integration_connections WHERE id=binding.connection_id FOR UPDATE;
 IF connection.id IS NULL THEN RAISE EXCEPTION 'Connection is unavailable' USING ERRCODE='42501'; END IF;
 PERFORM public.automation_marketplace_assert_scope_v1(connection.owner_scope_type,connection.owner_scope_id,connection.organization_id);
 PERFORM public.assert_capability_v1('automation_marketplace.manage_connections',connection.owner_scope_type,connection.owner_scope_id);
 runtime_id:=CASE WHEN connection.status='ready' AND connection.revoked_at IS NULL
   AND (connection.expires_at IS NULL OR connection.expires_at>now()) AND connection.secret_storage_mode='vault'
   AND connection.credentials_vault_id IS NOT NULL AND connection.provider_id IS NOT NULL THEN connection.runtime_auth_config_id ELSE NULL END;
 IF binding.runtime_resource_id IS DISTINCT FROM runtime_id OR binding.runtime_resource_type IS DISTINCT FROM (CASE WHEN runtime_id IS NULL THEN NULL ELSE 'provider_auth_configs' END) THEN
  RAISE EXCEPTION 'Materialized install bindings cannot change; create a fresh copy with the required bindings' USING ERRCODE='23514';
 END IF;
 RETURN jsonb_build_object('ok',TRUE,'noop',TRUE,'binding_id',binding.id,'install_id',install.id,
   'connection_id',connection.id,'runtime_auth_config_id',binding.runtime_resource_id);
END;
$function$;

-- Validate the materialized credential-reference closure, including object-valued variables.
CREATE FUNCTION public.automation_marketplace_assert_bound_auth_refs_v1(p_value JSONB,p_connections JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $function$
DECLARE entry RECORD;
BEGIN
 IF jsonb_typeof(p_value)='object' THEN
  FOR entry IN SELECT * FROM jsonb_each(p_value) LOOP
   IF entry.key IN ('auth_config_id','latest_auth_config_id') AND jsonb_typeof(entry.value)='string'
      AND (entry.value #>> '{}') !~ '^\{\{conn\.[A-Za-z0-9_-]+\.auth_config_id\}\}$'
      AND NOT EXISTS(SELECT 1 FROM jsonb_each(COALESCE(p_connections,'{}')) c WHERE c.value->'auth_config_id'=entry.value) THEN
    RAISE EXCEPTION 'Credential reference is not an authorized install binding' USING ERRCODE='42501';
   END IF;
   PERFORM public.automation_marketplace_assert_bound_auth_refs_v1(entry.value,p_connections);
  END LOOP;
 ELSIF jsonb_typeof(p_value)='array' THEN
  FOR entry IN SELECT value FROM jsonb_array_elements(p_value) LOOP
   PERFORM public.automation_marketplace_assert_bound_auth_refs_v1(entry.value,p_connections);
  END LOOP;
 END IF;
END;
$function$;

CREATE FUNCTION public.automation_marketplace_assert_install_references_v1(
 p_snapshot JSONB,p_scope_type TEXT,p_scope_id UUID,p_org UUID,p_connections JSONB DEFAULT '{}')
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE step JSONB; operation RECORD; provider UUID; template RECORD; binding JSONB:=p_snapshot #> '{version,workflow_binding}'; v_template_name TEXT;
BEGIN
 PERFORM public.automation_marketplace_assert_scope_v1(p_scope_type,p_scope_id,p_org);
 FOR step IN SELECT value FROM jsonb_array_elements(COALESCE(p_snapshot->'steps','[]')) LOOP
  IF NULLIF(step #>> '{metadata,operation_template_id}','') IS NOT NULL
     AND position('{{' IN step #>> '{metadata,operation_template_id}')=0 THEN
   SELECT ot.id,ot.provider_id,ot.metadata INTO operation FROM public.operation_templates ot JOIN public.providers p ON p.id=ot.provider_id
    WHERE ot.id=(step #>> '{metadata,operation_template_id}')::uuid AND p.organization_id=p_org AND p.enabled FOR SHARE OF ot,p;
   IF operation.id IS NULL THEN RAISE EXCEPTION 'Operation template is outside the install organization' USING ERRCODE='42501'; END IF;
   PERFORM public.assert_capability_v1('integrations.read',p_scope_type,p_scope_id);
   IF NULLIF(operation.metadata #>> '{auth,auth_config_id}','') IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM public.provider_auth_configs a WHERE a.id=NULLIF(operation.metadata #>> '{auth,auth_config_id}','')::uuid AND a.provider_id=operation.provider_id
   ) THEN RAISE EXCEPTION 'Operation credential provider mismatch' USING ERRCODE='42501'; END IF;
   IF EXISTS(SELECT 1 FROM public.provider_auth_configs a WHERE a.id=NULLIF(operation.metadata #>> '{auth,auth_config_id}','')::uuid AND a.marketplace_explicit_only)
      AND NOT EXISTS(SELECT 1 FROM jsonb_each(COALESCE(p_connections,'{}')) c WHERE c.value->>'auth_config_id'=operation.metadata #>> '{auth,auth_config_id}') THEN
    RAISE EXCEPTION 'Operation credential is not an authorized install binding' USING ERRCODE='42501';
   END IF;
  END IF;
  IF NULLIF(step #>> '{metadata,provider_id}','') IS NOT NULL AND position('{{' IN step #>> '{metadata,provider_id}')=0 THEN
   SELECT p.id INTO provider FROM public.providers p WHERE p.id=(step #>> '{metadata,provider_id}')::uuid AND p.organization_id=p_org AND p.enabled FOR SHARE;
   IF provider IS NULL THEN RAISE EXCEPTION 'Provider is outside the install organization' USING ERRCODE='42501'; END IF;
   PERFORM public.assert_capability_v1('integrations.read',p_scope_type,p_scope_id);
  END IF;
 END LOOP;
 IF jsonb_typeof(binding)='object' THEN
  v_template_name:=public.integration_plugin_resolve_template_name_v1(binding);
  IF v_template_name IS NOT NULL AND position('{{' IN v_template_name)=0 THEN
   SELECT wt.* INTO template FROM public.workflow_templates wt WHERE wt.name=v_template_name FOR SHARE;
   IF template.id IS NOT NULL AND NOT (
      (template.scope_type=public.get_root_scope_type_key_v1() AND template.scope_id IS NULL)
      OR (template.scope_type=p_scope_type AND template.scope_id=p_scope_id
          AND public.resolve_organization_id_for_scope_v1(template.scope_type,template.scope_id)=p_org)
   ) THEN RAISE EXCEPTION 'Workflow binding is outside the install scope' USING ERRCODE='42501'; END IF;
   IF template.id IS NOT NULL AND NOT public.request_role_is_service_v1() AND NOT public.workflow_template_scope_allowed(template.scope_type,template.scope_id) THEN
    RAISE EXCEPTION 'Workflow binding is outside actor scope' USING ERRCODE='42501';
   END IF;
  END IF;
 END IF;
EXCEPTION WHEN invalid_text_representation THEN
 RAISE EXCEPTION 'Install resource reference must be a valid identifier' USING ERRCODE='23514';
END;
$function$;


CREATE OR REPLACE FUNCTION public.automation_asset_install_v1(
  p_listing_version_id UUID,
  p_target_scope_type TEXT,
  p_target_scope_id UUID,
  p_variable_values JSONB DEFAULT '{}'::jsonb,
  p_connection_bindings JSONB DEFAULT '{}'::jsonb,
  p_activate BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_version public.automation_asset_listing_versions%ROWTYPE;
  v_listing public.automation_asset_listings%ROWTYPE;
  v_target_scope_type TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(p_target_scope_type, '')), ''), public.current_user_scope_type(), 'tenant'));
  v_target_scope_id UUID := COALESCE(p_target_scope_id, public.current_user_scope_id(), public.current_user_org_id());
  v_target_org_id UUID;
  v_policy JSONB;
  v_allowed_target BOOLEAN := FALSE;
  v_allowed_manifest_target BOOLEAN := TRUE;
  v_required_connection_key TEXT;
  v_install_id UUID;
  v_installed_resource_id UUID;
  v_installed_resource_type TEXT;
  v_template_name TEXT;
  v_template_id UUID;
  v_step JSONB;
  v_schedule JSONB;
  v_binding RECORD;
  v_variable RECORD;
  v_snapshot JSONB;
  v_context JSONB;
  v_plugin JSONB;
  v_plugin_version JSONB;
  v_plugin_id UUID;
  v_plugin_version_id UUID;
  v_plugin_version_no INTEGER;
  v_plugin_key TEXT;
  v_counter INTEGER := 1;
  v_constraint TEXT;
  v_activation_result JSONB := jsonb_build_object('activated',FALSE);
BEGIN
  IF p_listing_version_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_install_v1 requires listing_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.automation_asset_listing_versions
  WHERE id = p_listing_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_install_v1 listing version % not found', p_listing_version_id;
  END IF;

  SELECT * INTO v_listing
  FROM public.automation_asset_listings
  WHERE id = v_version.listing_id
  LIMIT 1;

  v_target_org_id := public.resolve_organization_id_for_scope_v1(v_target_scope_type, v_target_scope_id);
  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_install_v1 invalid target scope %/%', v_target_scope_type, v_target_scope_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_target_scope_type,v_target_scope_id,v_target_org_id);
  IF NOT public.automation_marketplace_can_read_asset_v1(v_version.organization_id,v_listing.owner_scope_type,v_listing.owner_scope_id,v_version.visibility,v_version.publication_status) THEN
    RAISE EXCEPTION 'Listing version is outside actor scope' USING ERRCODE='42501';
  END IF;
  IF v_version.publication_status<>'approved' THEN
    RAISE EXCEPTION 'Install requires an approved listing version' USING ERRCODE='23514';
  END IF;
  PERFORM public.automation_marketplace_assert_secret_free_v1(p_variable_values);

  PERFORM public.assert_capability_v1('automation_marketplace.install', v_target_scope_type, v_target_scope_id);

  v_policy := public.automation_marketplace_resolve_policy_v1(v_target_scope_type, v_target_scope_id, v_target_org_id);

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(v_policy #> '{install,allowed_target_scope_types}', '[]'::jsonb)) AS value
    WHERE lower(value) = v_target_scope_type
  )
    INTO v_allowed_target;

  IF v_allowed_target IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'automation_asset_install_v1 target scope type % is not allowed by policy', v_target_scope_type;
  END IF;

  IF jsonb_typeof(v_version.manifest #> '{install_constraints,allowed_target_scope_types}') = 'array' THEN
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_version.manifest #> '{install_constraints,allowed_target_scope_types}') AS value
      WHERE lower(value) = v_target_scope_type
    )
      INTO v_allowed_manifest_target;

    IF v_allowed_manifest_target IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'automation_asset_install_v1 target scope type % is not allowed by the listing manifest', v_target_scope_type;
    END IF;
  END IF;

  IF v_version.visibility = 'private' THEN
    IF v_listing.owner_scope_type <> v_target_scope_type OR v_listing.owner_scope_id <> v_target_scope_id THEN
      RAISE EXCEPTION 'automation_asset_install_v1 private listings may only be installed by the owner scope';
    END IF;
  ELSIF v_version.visibility = 'tenant_shared' THEN
    IF v_listing.organization_id IS DISTINCT FROM v_target_org_id THEN
      RAISE EXCEPTION 'automation_asset_install_v1 tenant_shared listings cannot cross tenant boundaries';
    END IF;
  ELSIF v_version.visibility = 'marketplace_public' THEN
    IF v_version.publication_status <> 'approved' THEN
      RAISE EXCEPTION 'automation_asset_install_v1 marketplace_public listings must be approved';
    END IF;
  END IF;

  FOREACH v_required_connection_key IN ARRAY COALESCE(
    public.automation_marketplace_manifest_keys_v1(v_version.manifest, 'connections'),
    ARRAY[]::TEXT[]
  )
  LOOP
    IF NOT (COALESCE(p_connection_bindings, '{}'::jsonb) ? v_required_connection_key) THEN
      RAISE EXCEPTION 'automation_asset_install_v1 missing required connection binding %', v_required_connection_key;
    END IF;

    IF NULLIF(
      COALESCE(
        COALESCE(p_connection_bindings, '{}'::jsonb)->v_required_connection_key->>'connection_id',
        ''
      ),
      ''
    ) IS NULL THEN
      RAISE EXCEPTION 'automation_asset_install_v1 connection binding % requires connection_id', v_required_connection_key;
    END IF;
  END LOOP;

  v_context:=public.automation_marketplace_install_context_v1(v_version.manifest,p_variable_values,p_connection_bindings,v_target_scope_type,v_target_scope_id,v_target_org_id);
  v_snapshot:=public.automation_marketplace_resolve_install_payload_v1(v_version.snapshot_payload,v_context->'var',v_context->'conn',v_context->'scope');
  PERFORM public.automation_marketplace_assert_bound_auth_refs_v1(v_snapshot,v_context->'conn');
  PERFORM public.automation_marketplace_assert_install_references_v1(v_snapshot,v_target_scope_type,v_target_scope_id,v_target_org_id,v_context->'conn');
  IF p_activate AND EXISTS(SELECT 1 FROM unnest(public.automation_marketplace_extract_placeholders_v1(v_snapshot)) p WHERE p ~ '^(var|conn|scope|secret)\.') THEN
    RAISE EXCEPTION 'Activation requires resolved install values; replace secret placeholders with a declared connection auth_config_id and native auth mode' USING ERRCODE='23514';
  END IF;

  IF v_version.asset_kind = 'workflow_template' THEN
    v_template_name := public.automation_marketplace_unique_workflow_name_v1(
      COALESCE(NULLIF(v_snapshot #>> '{template,name}', ''), v_listing.title)
    );

    INSERT INTO public.workflow_templates (
      name,
      description,
      version,
      status,
      scope_type,
      scope_id,
      created_by,
      notes,
      steps_checksum
    )
    VALUES (
      v_template_name,
      NULLIF(v_snapshot #>> '{template,description}', ''),
      COALESCE((v_snapshot #>> '{template,version}')::integer, 1),
      'draft',
      v_target_scope_type,
      v_target_scope_id,
      auth.uid(),
      NULLIF(v_snapshot #>> '{template,notes}', ''),
      NULLIF(v_snapshot #>> '{template,steps_checksum}', '')
    )
    RETURNING id INTO v_template_id;

    FOR v_step IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_snapshot->'steps', '[]'::jsonb))
    LOOP
      INSERT INTO public.workflow_template_steps (
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        condition_jsonlogic,
        next_operation_name,
        next_operation_priority,
        next_operation_delay_seconds,
        manual_action_required,
        metadata,
        enabled,
        handler_key,
        handler_version
      )
      VALUES (
        v_template_id,
        COALESCE((v_step->>'sequence_order')::integer, 1),
        COALESCE(NULLIF(v_step->>'operation_name', ''), 'noop'),
        NULLIF(v_step->>'operation_settings_category', ''),
        COALESCE(NULLIF(v_step->>'transition_condition', ''), 'success'),
        v_step->'condition_jsonlogic',
        NULLIF(v_step->>'next_operation_name', ''),
        (v_step->>'next_operation_priority')::integer,
        (v_step->>'next_operation_delay_seconds')::integer,
        COALESCE((v_step->>'manual_action_required')::boolean, FALSE),
        CASE
          WHEN v_step ? 'handler_key'
            AND NOT (COALESCE(v_step->'metadata', '{}'::jsonb) ? 'handler_key')
          THEN COALESCE(v_step->'metadata', '{}'::jsonb) || jsonb_build_object('handler_key', v_step->>'handler_key')
          ELSE COALESCE(v_step->'metadata', '{}'::jsonb)
        END,
        COALESCE((v_step->>'enabled')::boolean, TRUE),
        COALESCE(NULLIF(v_step->>'handler_key', ''), COALESCE(NULLIF(v_step->>'operation_name', ''), 'noop')),
        NULLIF(v_step->>'handler_version', '')
      );
    END LOOP;

    FOR v_schedule IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_snapshot->'schedule_triggers', '[]'::jsonb))
    LOOP
      INSERT INTO public.workflow_schedule_triggers (
        organization_id,
        scope_type,
        scope_id,
        workflow_template_id,
        schedule,
        context_patch,
        enabled,
        next_run_at,
        created_by,
        notes
      )
      VALUES (
        v_target_org_id,
        v_target_scope_type,
        v_target_scope_id,
        v_template_id,
        COALESCE(v_schedule->'schedule', '{}'::jsonb),
        COALESCE(v_schedule->'context_patch', '{}'::jsonb),
        COALESCE((v_schedule->>'enabled')::boolean, TRUE),
        public.workflow_schedule_trigger_next_run_at(COALESCE(v_schedule->'schedule', '{}'::jsonb), now()),
        auth.uid(),
        NULLIF(v_schedule->>'notes', '')
      );
    END LOOP;

    v_installed_resource_type := 'workflow_template';
    v_installed_resource_id := v_template_id;
  ELSIF v_version.asset_kind = 'integration_plugin' THEN
    v_plugin := COALESCE(v_snapshot->'plugin', '{}'::jsonb);
    v_plugin_version := COALESCE(v_snapshot->'version', '{}'::jsonb);
    v_plugin_key := COALESCE(NULLIF(v_plugin->>'plugin_key', ''), left(gen_random_uuid()::text, 12));

    LOOP
      BEGIN
        INSERT INTO public.integration_plugins (
          organization_id,
          plugin_key,
          name,
          description,
          plugin_kind,
          status,
          reusable_within_tenant,
          rollout_tier,
          managed_by,
          metadata,
          created_by,
          updated_by
        )
        VALUES (
          v_target_org_id,
          CASE WHEN v_counter = 1 THEN v_plugin_key ELSE left(v_plugin_key,120-length(v_counter::text)-1)||'-'||v_counter::text END,
          COALESCE(NULLIF(v_plugin->>'name', ''), v_listing.title),
          NULLIF(v_plugin->>'description', ''),
          COALESCE(NULLIF(v_plugin->>'plugin_kind', ''), 'workflow'),
          'draft',
          COALESCE((v_plugin->>'reusable_within_tenant')::boolean, TRUE),
          COALESCE(NULLIF(v_plugin->>'rollout_tier', ''), 'tenant'),
          COALESCE(NULLIF(v_plugin->>'managed_by', ''), 'automation_marketplace'),
          COALESCE(v_plugin->'metadata', '{}'::jsonb),
          auth.uid(),
          auth.uid()
        )
        RETURNING id INTO v_plugin_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
        IF v_constraint IS DISTINCT FROM 'integration_plugins_unique_org_key' THEN RAISE; END IF;
        v_counter := v_counter + 1;
      END;
    END LOOP;

    v_plugin_version_no := COALESCE((v_plugin_version->>'version_no')::integer, 1);

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
      validation_summary,
      approved_at,
      approved_by,
      artifact_hash,
      diff_hash,
      metadata,
      created_by,
      updated_by
    )
    VALUES (
      v_plugin_id,
      v_target_org_id,
      v_plugin_version_no,
      CASE WHEN p_activate THEN 'approved' ELSE 'draft' END,
      COALESCE(NULLIF(v_plugin_version->>'source_type', ''), 'marketplace_install'),
      COALESCE(v_plugin_version->'source_payload', '{}'::jsonb),
      COALESCE(v_plugin_version->'normalized_contract', '{}'::jsonb),
      COALESCE(v_plugin_version->'inbound_config', '{}'::jsonb),
      COALESCE(v_plugin_version->'mapping_config', '{}'::jsonb),
      COALESCE(v_plugin_version->'workflow_binding', '{}'::jsonb),
      COALESCE(v_plugin_version->'outbound_operations', '[]'::jsonb),
      COALESCE(v_plugin_version->'auth_bindings', '{}'::jsonb),
      COALESCE(v_plugin_version->'validation_summary', '{}'::jsonb),
      CASE WHEN p_activate THEN now() ELSE NULL END,
      CASE WHEN p_activate THEN auth.uid() ELSE NULL END,
      NULLIF(v_plugin_version->>'artifact_hash', ''),
      NULLIF(v_plugin_version->>'diff_hash', ''),
      COALESCE(v_plugin_version->'metadata', '{}'::jsonb),
      auth.uid(),
      auth.uid()
    )
    RETURNING id INTO v_plugin_version_id;


    v_installed_resource_type := 'integration_plugin';
    v_installed_resource_id := v_plugin_id;
  ELSE
    RAISE EXCEPTION 'automation_asset_install_v1 unsupported asset_kind=%', v_version.asset_kind;
  END IF;

  INSERT INTO public.automation_asset_installs (
    listing_id,
    installed_from_listing_version_id,
    current_listing_version_id,
    organization_id,
    asset_kind,
    target_scope_type,
    target_scope_id,
    install_status,
    installed_resource_type,
    installed_resource_id,
    metadata,
    created_by,
    updated_by,
    installed_at
  )
  VALUES (
    v_listing.id,
    v_version.id,
    v_version.id,
    v_target_org_id,
    v_version.asset_kind,
    v_target_scope_type,
    v_target_scope_id,
    'installed',
    v_installed_resource_type,
    v_installed_resource_id,
    jsonb_build_object(
      'activation_result', COALESCE(v_activation_result, 'null'::jsonb),
      'source_snapshot_type', v_version.source_snapshot_type,
      'source_snapshot_id', v_version.source_snapshot_id
    ),
    auth.uid(),
    auth.uid(),
    now()
  )
  RETURNING id INTO v_install_id;

  FOR v_variable IN
    SELECT key, value
    FROM jsonb_each(COALESCE(p_variable_values, '{}'::jsonb))
  LOOP
    INSERT INTO public.automation_asset_install_variables (
      install_id,
      variable_key,
      value,
      created_by
    )
    VALUES (
      v_install_id,
      v_variable.key,
      v_variable.value,
      auth.uid()
    );
  END LOOP;

  FOR v_binding IN
    SELECT key, value
    FROM jsonb_each(COALESCE(p_connection_bindings, '{}'::jsonb))
  LOOP
    PERFORM public.automation_marketplace_bind_install_initial_v1(
      v_install_id,
      v_binding.key,
      (v_binding.value->>'connection_id')::uuid,
      COALESCE(v_binding.value->>'binding_type', 'connection'),
      COALESCE(v_binding.value->'config', '{}'::jsonb)
    );
  END LOOP;

  IF p_activate THEN
    PERFORM public.automation_marketplace_assert_activation_v1(v_install_id,v_snapshot);
    IF v_version.asset_kind='integration_plugin' THEN
      BEGIN
        v_activation_result:=public.integration_plugin_activate_v1(
          p_plugin_version_id:=v_plugin_version_id,p_scope_type:=v_target_scope_type,
          p_scope_id:=v_target_scope_id,p_reason:='Activated from automation marketplace install'
        );
        IF COALESCE((v_activation_result->>'ok')::boolean,FALSE) IS NOT TRUE
          OR NOT EXISTS(SELECT 1 FROM public.integration_plugins p WHERE p.id=v_plugin_id AND p.status='active' AND p.active_version_id=v_plugin_version_id) THEN
          RAISE EXCEPTION 'Native activation did not confirm active state';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Marketplace activation failed; no install was saved' USING ERRCODE='23514';
      END;
      -- Never persist the native one-time inbound secret in an install/readback row.
      v_activation_result:=jsonb_build_object('activated',TRUE,'plugin_version_id',v_plugin_version_id);
    ELSE
      UPDATE public.workflow_templates SET status='active' WHERE id=v_template_id AND scope_type=v_target_scope_type AND scope_id=v_target_scope_id;
      v_activation_result:=jsonb_build_object('activated',TRUE,'workflow_template_id',v_template_id);
    END IF;
    UPDATE public.automation_asset_installs SET metadata=jsonb_set(metadata,'{activation_result}',v_activation_result,true) WHERE id=v_install_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'install_id', v_install_id,
    'installed_resource_type', v_installed_resource_type,
    'installed_resource_id', v_installed_resource_id,
    'activation_result', COALESCE(v_activation_result, 'null'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_upgrade_preview_v1(
  p_install_id UUID,
  p_target_listing_version_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_install public.automation_asset_installs%ROWTYPE;
  v_current_version public.automation_asset_listing_versions%ROWTYPE;
  v_target_version public.automation_asset_listing_versions%ROWTYPE;
BEGIN
  IF p_install_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_upgrade_preview_v1 requires install_id';
  END IF;

  SELECT * INTO v_install
  FROM public.automation_asset_installs
  WHERE id = p_install_id
  FOR UPDATE;

  IF v_install.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_upgrade_preview_v1 install % not found', p_install_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_install.target_scope_type, v_install.target_scope_id, v_install.organization_id);
  IF v_install.install_status='revoked' THEN RAISE EXCEPTION 'Install is revoked' USING ERRCODE='23514'; END IF;

  PERFORM public.assert_capability_v1('automation_marketplace.upgrade', v_install.target_scope_type, v_install.target_scope_id);

  SELECT * INTO v_current_version
  FROM public.automation_asset_listing_versions
  WHERE id = v_install.current_listing_version_id
  FOR UPDATE;

  IF p_target_listing_version_id IS NULL THEN
    SELECT v.*
      INTO v_target_version
      FROM public.automation_asset_listing_versions v
      JOIN public.automation_asset_listings l ON l.latest_listing_version_id=v.id
     WHERE l.id=v_install.listing_id AND l.publication_status='approved'
       AND v.publication_status='approved'
     FOR UPDATE OF v;
  ELSE
    SELECT * INTO v_target_version
    FROM public.automation_asset_listing_versions
    WHERE id = p_target_listing_version_id
    FOR UPDATE;
  END IF;

  IF v_target_version.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_upgrade_preview_v1 target listing version not found';
  END IF;

  IF v_target_version.listing_id <> v_install.listing_id THEN
    RAISE EXCEPTION 'automation_asset_upgrade_preview_v1 target listing version is incompatible with the install';
  END IF;

  IF v_target_version.publication_status <> 'approved' THEN
    RAISE EXCEPTION 'automation_asset_upgrade_preview_v1 target listing version must be approved';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.automation_asset_listings l WHERE l.id=v_target_version.listing_id
    AND public.automation_marketplace_can_read_asset_v1(v_target_version.organization_id,l.owner_scope_type,l.owner_scope_id,v_target_version.visibility,v_target_version.publication_status)) THEN
    RAISE EXCEPTION 'Listing version is outside actor scope' USING ERRCODE='42501';
  END IF;
  IF v_target_version.listing_version_no<v_current_version.listing_version_no THEN
    RAISE EXCEPTION 'Downgrade is not permitted' USING ERRCODE='23514';
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'install_id', v_install.id,
    'forked', v_install.forked_at IS NOT NULL OR v_install.install_status = 'forked',
    'current_listing_version_id', v_current_version.id,
    'target_listing_version_id', v_target_version.id,
    'current_artifact_hash', v_current_version.artifact_hash,
    'target_artifact_hash', v_target_version.artifact_hash,
    'has_changes', v_current_version.id IS DISTINCT FROM v_target_version.id OR v_current_version.artifact_hash IS DISTINCT FROM v_target_version.artifact_hash
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_upgrade_apply_v1(
  p_install_id UUID,
  p_target_listing_version_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_install public.automation_asset_installs%ROWTYPE;
  v_preview JSONB;
  v_target_version public.automation_asset_listing_versions%ROWTYPE;
  v_snapshot JSONB;
  v_context JSONB;
  v_variables JSONB;
  v_bindings JSONB;
  v_step JSONB;
  v_schedule JSONB;
  v_existing_template RECORD;
  v_plugin RECORD;
  v_new_plugin_version_id UUID;
  v_next_plugin_version_no INTEGER;
BEGIN
  IF p_install_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_upgrade_apply_v1 requires install_id';
  END IF;

  SELECT * INTO v_install
  FROM public.automation_asset_installs
  WHERE id = p_install_id
  FOR UPDATE;

  IF v_install.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_upgrade_apply_v1 install % not found', p_install_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_install.target_scope_type, v_install.target_scope_id, v_install.organization_id);
  IF v_install.install_status='revoked' THEN RAISE EXCEPTION 'Install is revoked' USING ERRCODE='23514'; END IF;

  PERFORM public.assert_capability_v1('automation_marketplace.upgrade', v_install.target_scope_type, v_install.target_scope_id);

  v_preview := public.automation_asset_upgrade_preview_v1(p_install_id, p_target_listing_version_id);

  IF COALESCE((v_preview->>'forked')::boolean, FALSE) THEN
    RAISE EXCEPTION 'automation_asset_upgrade_apply_v1 cannot overwrite a forked install';
  END IF;

  IF COALESCE((v_preview->>'has_changes')::boolean, FALSE) = FALSE THEN
    RETURN jsonb_build_object('ok', TRUE, 'install_id', v_install.id, 'status', 'noop');
  END IF;

  SELECT * INTO v_target_version
  FROM public.automation_asset_listing_versions
  WHERE id = COALESCE(p_target_listing_version_id, (v_preview->>'target_listing_version_id')::uuid)
  FOR UPDATE;

  SELECT COALESCE(jsonb_object_agg(variable_key,value),'{}') INTO v_variables FROM public.automation_asset_install_variables WHERE install_id=v_install.id;
  SELECT COALESCE(jsonb_object_agg(binding_key,jsonb_build_object('connection_id',connection_id)),'{}') INTO v_bindings FROM public.automation_asset_install_bindings WHERE install_id=v_install.id;
  v_context:=public.automation_marketplace_install_context_v1(v_target_version.manifest,v_variables,v_bindings,v_install.target_scope_type,v_install.target_scope_id,v_install.organization_id);
  v_snapshot:=public.automation_marketplace_resolve_install_payload_v1(v_target_version.snapshot_payload,v_context->'var',v_context->'conn',v_context->'scope');
  PERFORM public.automation_marketplace_assert_bound_auth_refs_v1(v_snapshot,v_context->'conn');
  PERFORM public.automation_marketplace_assert_install_references_v1(v_snapshot,v_install.target_scope_type,v_install.target_scope_id,v_install.organization_id,v_context->'conn');
  IF EXISTS(SELECT 1 FROM unnest(public.automation_marketplace_extract_placeholders_v1(v_snapshot)) p WHERE p ~ '^(var|conn|scope|secret)\.') THEN
    RAISE EXCEPTION 'Upgrade requires resolved install values; use declared connection auth_config_id and native auth mode' USING ERRCODE='23514';
  END IF;

  IF v_install.asset_kind = 'workflow_template' THEN
    SELECT * INTO v_existing_template
    FROM public.workflow_templates
    WHERE id = v_install.installed_resource_id
    FOR UPDATE;

    IF v_existing_template.id IS NULL THEN
      RAISE EXCEPTION 'automation_asset_upgrade_apply_v1 workflow template install target missing';
    END IF;

    IF v_existing_template.scope_type IS DISTINCT FROM v_install.target_scope_type OR v_existing_template.scope_id IS DISTINCT FROM v_install.target_scope_id THEN
      RAISE EXCEPTION 'Install target scope changed' USING ERRCODE='42501';
    END IF;
    PERFORM public.automation_marketplace_assert_scope_v1(v_existing_template.scope_type,v_existing_template.scope_id,v_install.organization_id);

    UPDATE public.workflow_templates
       SET description = NULLIF(v_snapshot #>> '{template,description}', ''),
           version = COALESCE((v_snapshot #>> '{template,version}')::integer, version),
           notes = NULLIF(v_snapshot #>> '{template,notes}', ''),
           steps_checksum = NULLIF(v_snapshot #>> '{template,steps_checksum}', ''),
           created_by = COALESCE(created_by, auth.uid())
     WHERE id = v_existing_template.id;

    DELETE FROM public.workflow_template_steps
     WHERE workflow_template_id = v_existing_template.id;

    FOR v_step IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_snapshot->'steps', '[]'::jsonb))
    LOOP
      INSERT INTO public.workflow_template_steps (
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        condition_jsonlogic,
        next_operation_name,
        next_operation_priority,
        next_operation_delay_seconds,
        manual_action_required,
        metadata,
        enabled,
        handler_key,
        handler_version
      )
      VALUES (
        v_existing_template.id,
        COALESCE((v_step->>'sequence_order')::integer, 1),
        COALESCE(NULLIF(v_step->>'operation_name', ''), 'noop'),
        NULLIF(v_step->>'operation_settings_category', ''),
        COALESCE(NULLIF(v_step->>'transition_condition', ''), 'success'),
        v_step->'condition_jsonlogic',
        NULLIF(v_step->>'next_operation_name', ''),
        (v_step->>'next_operation_priority')::integer,
        (v_step->>'next_operation_delay_seconds')::integer,
        COALESCE((v_step->>'manual_action_required')::boolean, FALSE),
        COALESCE(v_step->'metadata', '{}'::jsonb),
        COALESCE((v_step->>'enabled')::boolean, TRUE),
        COALESCE(NULLIF(v_step->>'handler_key', ''), COALESCE(NULLIF(v_step->>'operation_name', ''), 'noop')),
        NULLIF(v_step->>'handler_version', '')
      );
    END LOOP;

    DELETE FROM public.workflow_schedule_triggers
     WHERE workflow_template_id = v_existing_template.id
       AND scope_type = v_install.target_scope_type
       AND scope_id = v_install.target_scope_id;

    FOR v_schedule IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_snapshot->'schedule_triggers', '[]'::jsonb))
    LOOP
      INSERT INTO public.workflow_schedule_triggers (
        organization_id,
        scope_type,
        scope_id,
        workflow_template_id,
        schedule,
        context_patch,
        enabled,
        next_run_at,
        created_by,
        notes
      )
      VALUES (
        v_install.organization_id,
        v_install.target_scope_type,
        v_install.target_scope_id,
        v_existing_template.id,
        COALESCE(v_schedule->'schedule', '{}'::jsonb),
        COALESCE(v_schedule->'context_patch', '{}'::jsonb),
        COALESCE((v_schedule->>'enabled')::boolean, TRUE),
        public.workflow_schedule_trigger_next_run_at(COALESCE(v_schedule->'schedule', '{}'::jsonb), now()),
        auth.uid(),
        NULLIF(v_schedule->>'notes', '')
      );
    END LOOP;
  ELSIF v_install.asset_kind = 'integration_plugin' THEN
    SELECT * INTO v_plugin
    FROM public.integration_plugins
    WHERE id = v_install.installed_resource_id
    FOR UPDATE;

    IF v_plugin.id IS NULL THEN
      RAISE EXCEPTION 'automation_asset_upgrade_apply_v1 integration plugin install target missing';
    END IF;

    IF v_plugin.organization_id IS DISTINCT FROM v_install.organization_id THEN
      RAISE EXCEPTION 'Install target organization changed' USING ERRCODE='42501';
    END IF;

    SELECT COALESCE(MAX(version_no), 0) + 1
      INTO v_next_plugin_version_no
      FROM public.integration_plugin_versions
     WHERE plugin_id = v_plugin.id;

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
      validation_summary,
      approved_at,
      approved_by,
      artifact_hash,
      diff_hash,
      metadata,
      created_by,
      updated_by
    )
    VALUES (
      v_plugin.id,
      v_install.organization_id,
      v_next_plugin_version_no,
      'approved',
      COALESCE(NULLIF(v_snapshot #>> '{version,source_type}', ''), 'marketplace_upgrade'),
      COALESCE(v_snapshot #> '{version,source_payload}', '{}'::jsonb),
      COALESCE(v_snapshot #> '{version,normalized_contract}', '{}'::jsonb),
      COALESCE(v_snapshot #> '{version,inbound_config}', '{}'::jsonb),
      COALESCE(v_snapshot #> '{version,mapping_config}', '{}'::jsonb),
      COALESCE(v_snapshot #> '{version,workflow_binding}', '{}'::jsonb),
      COALESCE(v_snapshot #> '{version,outbound_operations}', '[]'::jsonb),
      COALESCE(v_snapshot #> '{version,auth_bindings}', '{}'::jsonb),
      COALESCE(v_snapshot #> '{version,validation_summary}', '{}'::jsonb),
      now(),
      auth.uid(),
      NULLIF(v_snapshot #>> '{version,artifact_hash}', ''),
      NULLIF(v_snapshot #>> '{version,diff_hash}', ''),
      COALESCE(v_snapshot #> '{version,metadata}', '{}'::jsonb),
      auth.uid(),
      auth.uid()
    )
    RETURNING id INTO v_new_plugin_version_id;

    UPDATE public.integration_plugins
       SET name = COALESCE(NULLIF(v_snapshot #>> '{plugin,name}', ''), name),
           description = COALESCE(NULLIF(v_snapshot #>> '{plugin,description}', ''), description),
           plugin_kind = COALESCE(NULLIF(v_snapshot #>> '{plugin,plugin_kind}', ''), plugin_kind),
           rollout_tier = COALESCE(NULLIF(v_snapshot #>> '{plugin,rollout_tier}', ''), rollout_tier),
           metadata = COALESCE(v_snapshot #> '{plugin,metadata}', metadata),
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = v_plugin.id;
  ELSE
    RAISE EXCEPTION 'automation_asset_upgrade_apply_v1 unsupported asset_kind=%', v_install.asset_kind;
  END IF;

  UPDATE public.automation_asset_installs
     SET current_listing_version_id = v_target_version.id,
         metadata=CASE WHEN v_new_plugin_version_id IS NULL THEN metadata ELSE jsonb_set(metadata,'{pending_plugin_version_id}',to_jsonb(v_new_plugin_version_id),true) END,
         upgrade_available = FALSE,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_install.id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'install_id', v_install.id,
    'target_listing_version_id', v_target_version.id
    ,'runtime_activated',FALSE
    ,'staged_plugin_version_id',v_new_plugin_version_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.automation_asset_fork_v1(
  p_install_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_install public.automation_asset_installs%ROWTYPE;
BEGIN
  IF p_install_id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_fork_v1 requires install_id';
  END IF;

  SELECT * INTO v_install
  FROM public.automation_asset_installs
  WHERE id = p_install_id
  FOR UPDATE;

  IF v_install.id IS NULL THEN
    RAISE EXCEPTION 'automation_asset_fork_v1 install % not found', p_install_id;
  END IF;

  PERFORM public.automation_marketplace_assert_scope_v1(v_install.target_scope_type, v_install.target_scope_id, v_install.organization_id);
  IF v_install.install_status='revoked' THEN RAISE EXCEPTION 'Install is revoked' USING ERRCODE='23514'; END IF;

  PERFORM public.assert_capability_v1('automation_marketplace.upgrade', v_install.target_scope_type, v_install.target_scope_id);

  UPDATE public.automation_asset_installs
     SET install_status = 'forked',
         forked_at = COALESCE(forked_at, now()),
         metadata = CASE WHEN NULLIF(btrim(p_reason),'') IS NULL THEN metadata ELSE jsonb_set(COALESCE(metadata,'{}'),'{fork_reason}',to_jsonb(btrim(p_reason)),true) END,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_install.id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'install_id', v_install.id,
    'install_status', 'forked'
  );
END;
$function$;

-- Resolve only exact, declared marketplace values. Do not render or rewrite runtime expressions.
CREATE FUNCTION public.automation_marketplace_resolve_install_payload_v1(
 p_value JSONB,p_variables JSONB,p_connections JSONB,p_scope JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions,pg_temp AS $function$
DECLARE result JSONB; entry RECORD; token TEXT; parts TEXT[]; value JSONB;
BEGIN
 IF jsonb_typeof(p_value)='object' THEN
  result:='{}';
  FOR entry IN SELECT * FROM jsonb_each(p_value) LOOP
   IF entry.key IN ('auth_config_id','latest_auth_config_id') AND jsonb_typeof(entry.value)='string'
     AND (entry.value #>> '{}') !~ '^\{\{conn\.[A-Za-z0-9_-]+\.auth_config_id\}\}$' THEN
    RAISE EXCEPTION 'Shared credential references must use a declared connection auth_config_id' USING ERRCODE='23514';
   END IF;
   result:=result || jsonb_build_object(entry.key,public.automation_marketplace_resolve_install_payload_v1(entry.value,p_variables,p_connections,p_scope));
  END LOOP;
  RETURN result;
 ELSIF jsonb_typeof(p_value)='array' THEN
  result:='[]';
  FOR entry IN SELECT element.value FROM jsonb_array_elements(p_value) AS element LOOP
   result:=result || jsonb_build_array(public.automation_marketplace_resolve_install_payload_v1(entry.value,p_variables,p_connections,p_scope));
  END LOOP;
  RETURN result;
 ELSIF jsonb_typeof(p_value)='string' AND (p_value #>> '{}') ~ '^\{\{(var|conn|scope)\.[A-Za-z0-9_.-]+\}\}$' THEN
  token:=substring(p_value #>> '{}' FROM 3 FOR length(p_value #>> '{}')-4);
  parts:=string_to_array(token,'.');
  IF parts[1]='var' THEN value:=p_variables->substring(token FROM 5);
  ELSIF parts[1]='scope' THEN value:=p_scope->substring(token FROM 7);
  ELSIF parts[1]='conn' AND array_length(parts,1)=3 AND parts[3]='auth_config_id' THEN value:=NULLIF(p_connections #> ARRAY[parts[2],'auth_config_id'],'null'::jsonb);
  END IF;
  RETURN COALESCE(value,p_value);
 END IF;
 RETURN p_value;
END;
$function$;

CREATE FUNCTION public.automation_marketplace_install_context_v1(
 p_manifest JSONB,p_variables JSONB,p_bindings JSONB,p_scope_type TEXT,p_scope_id UUID,p_org UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE entry RECORD; connections JSONB:='{}'; runtime_id UUID;
 scope JSONB:=jsonb_build_object('scope_type',p_scope_type,'scope_id',p_scope_id,'organization_id',p_org,'tenant_id',p_org);
BEGIN
 PERFORM public.automation_marketplace_assert_scope_v1(p_scope_type,p_scope_id,p_org);
 IF jsonb_typeof(COALESCE(p_variables,'{}'))<>'object' OR jsonb_typeof(COALESCE(p_bindings,'{}'))<>'object' THEN
  RAISE EXCEPTION 'Install values and bindings must be objects' USING ERRCODE='23514';
 END IF;
 FOR entry IN SELECT * FROM jsonb_each(COALESCE(p_variables,'{}')) LOOP
  IF NOT entry.key=ANY(public.automation_marketplace_manifest_keys_v1(p_manifest,'variables')) THEN
   RAISE EXCEPTION 'Variable is not declared in manifest' USING ERRCODE='23514';
  END IF;
 END LOOP;
 FOR entry IN SELECT * FROM jsonb_each(COALESCE(p_bindings,'{}')) ORDER BY key LOOP
  runtime_id:=public.automation_marketplace_connection_for_install_v1((entry.value->>'connection_id')::uuid,p_scope_type,p_scope_id,p_org,p_manifest,entry.key);
  connections:=connections || jsonb_build_object(entry.key,jsonb_build_object('auth_config_id',runtime_id));
 END LOOP;
 IF p_scope_type='client' THEN scope:=scope || jsonb_build_object('client_id',p_scope_id);
 ELSIF p_scope_type='sender' THEN
  scope:=scope || jsonb_build_object('sender_id',p_scope_id,'client_id',(SELECT client_id FROM public.senders WHERE id=p_scope_id));
 END IF;
 RETURN jsonb_build_object('var',COALESCE(p_variables,'{}'),'conn',connections,'scope',scope);
EXCEPTION WHEN invalid_text_representation THEN
 RAISE EXCEPTION 'Connection binding must contain a valid identifier' USING ERRCODE='23514';
END;
$function$;

-- Only lifecycle entry points are exposed. No generic Vault getter or legacy OAuth result setter.
-- Guard later native/core/rollback activation too; draft copies do not require test evidence.
CREATE FUNCTION public.automation_marketplace_assert_activation_v1(p_install_id UUID,p_payload JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE install public.automation_asset_installs%ROWTYPE; binding RECORD; policy JSONB; connections JSONB:='{}'; runtime_id UUID;
BEGIN
 SELECT * INTO install FROM public.automation_asset_installs WHERE id=p_install_id;
 IF install.id IS NULL THEN RETURN; END IF;
 IF p_payload IS NULL THEN RAISE EXCEPTION 'Activation payload is unavailable' USING ERRCODE='23514'; END IF;
 PERFORM public.automation_marketplace_assert_scope_v1(install.target_scope_type,install.target_scope_id,install.organization_id);
 IF install.install_status='revoked' THEN RAISE EXCEPTION 'Install is revoked' USING ERRCODE='23514'; END IF;
 policy:=public.automation_marketplace_resolve_policy_v1(install.target_scope_type,install.target_scope_id,install.organization_id);
 FOR binding IN SELECT b.binding_key,b.runtime_resource_id,c.* FROM public.automation_asset_install_bindings b
   JOIN public.integration_connections c ON c.id=b.connection_id WHERE b.install_id=install.id ORDER BY c.id,b.binding_key FOR UPDATE OF c LOOP
  PERFORM public.automation_marketplace_assert_scope_v1(binding.owner_scope_type,binding.owner_scope_id,binding.organization_id);
  IF (NOT COALESCE((policy #>> '{connections,allow_cross_scope_reuse}')::boolean,FALSE)
       OR COALESCE(policy #>> '{connections,reuse_mode}','scope_local')='scope_local')
     AND (binding.owner_scope_type IS DISTINCT FROM install.target_scope_type OR binding.owner_scope_id IS DISTINCT FROM install.target_scope_id) THEN
   RAISE EXCEPTION 'Connection reuse is restricted to the install scope by policy' USING ERRCODE='23514';
  END IF;
  IF binding.organization_id IS DISTINCT FROM install.organization_id OR binding.status<>'ready'
     OR binding.revoked_at IS NOT NULL OR binding.expires_at<=now() THEN
   RAISE EXCEPTION 'Activation requires ready nonexpired connections' USING ERRCODE='23514';
  END IF;
  IF COALESCE((policy #>> '{connections,require_test_before_activation}')::boolean,TRUE)
     AND (binding.last_tested_at IS NULL OR binding.last_tested_credential_generation IS DISTINCT FROM binding.credential_generation) THEN
   RAISE EXCEPTION 'Activation requires a current-generation credential-presence check for each connection' USING ERRCODE='23514';
  END IF;
  runtime_id:=CASE WHEN binding.secret_storage_mode='vault' AND binding.credentials_vault_id IS NOT NULL
    AND binding.provider_id IS NOT NULL THEN binding.runtime_auth_config_id ELSE NULL END;
  IF binding.runtime_resource_id IS DISTINCT FROM runtime_id THEN
   RAISE EXCEPTION 'Materialized install bindings cannot change; create a fresh copy with the required bindings' USING ERRCODE='23514';
  END IF;
  connections:=connections || jsonb_build_object(binding.binding_key,jsonb_build_object('auth_config_id',runtime_id));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.automation_asset_install_bindings b WHERE b.install_id=install.id AND b.connection_id IS NULL) THEN
  RAISE EXCEPTION 'Activation requires available connections' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(public.automation_marketplace_extract_placeholders_v1(p_payload)) p WHERE p ~ '^(var|conn|scope|secret)\.') THEN
  RAISE EXCEPTION 'Activation requires resolved install values; replace secret placeholders with a declared connection auth_config_id and native auth mode' USING ERRCODE='23514';
 END IF;
 PERFORM public.automation_marketplace_assert_bound_auth_refs_v1(p_payload,connections);
 PERFORM public.automation_marketplace_assert_install_references_v1(p_payload,install.target_scope_type,install.target_scope_id,install.organization_id,connections);
END;
$function$;

CREATE FUNCTION public.automation_marketplace_activation_guard_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $function$
DECLARE install RECORD; payload JSONB; resource_id UUID; resource_type TEXT;
BEGIN
 IF TG_TABLE_NAME='workflow_templates' THEN
  IF NEW.status<>'active' THEN RETURN NEW; END IF;
  resource_id:=NEW.id; resource_type:='workflow_template';
  SELECT jsonb_build_object('steps',COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.sequence_order),'[]')) INTO payload
   FROM public.workflow_template_steps s WHERE s.workflow_template_id=NEW.id;
 ELSIF TG_TABLE_NAME='integration_plugin_versions' THEN
  IF NEW.status<>'active' THEN RETURN NEW; END IF;
  resource_id:=NEW.plugin_id; resource_type:='integration_plugin';
  payload:=jsonb_build_object('version',to_jsonb(NEW)-'auth_bindings'-'validation_summary');
 ELSE
  IF NEW.status<>'active' OR NEW.active_version_id IS NULL THEN RETURN NEW; END IF;
  resource_id:=NEW.id; resource_type:='integration_plugin';
  SELECT jsonb_build_object('version',to_jsonb(v)-'auth_bindings'-'validation_summary') INTO payload
   FROM public.integration_plugin_versions v WHERE v.id=NEW.active_version_id AND v.plugin_id=NEW.id;
 END IF;
 FOR install IN SELECT id FROM public.automation_asset_installs WHERE installed_resource_type=resource_type AND installed_resource_id=resource_id ORDER BY id LOOP
  PERFORM public.automation_marketplace_assert_activation_v1(install.id,payload);
 END LOOP;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER automation_marketplace_activation_guard BEFORE UPDATE OF status ON public.workflow_templates
 FOR EACH ROW EXECUTE FUNCTION public.automation_marketplace_activation_guard_v1();
CREATE TRIGGER automation_marketplace_activation_guard BEFORE UPDATE OF status,activated_at ON public.integration_plugin_versions
 FOR EACH ROW EXECUTE FUNCTION public.automation_marketplace_activation_guard_v1();
CREATE TRIGGER automation_marketplace_activation_guard BEFORE UPDATE OF status,active_version_id ON public.integration_plugins
 FOR EACH ROW EXECUTE FUNCTION public.automation_marketplace_activation_guard_v1();

DO $acl$
DECLARE f RECORD;
BEGIN
 FOR f IN SELECT p.oid::regprocedure identity,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND (p.proname=ANY(ARRAY[
'automation_marketplace_hash_payload_v1',
'automation_marketplace_next_listing_version_no_v1',
'automation_marketplace_secret_text_v1',
'automation_marketplace_store_secret_payload_v1',
'automation_marketplace_resolve_policy_v1',
'automation_marketplace_extract_placeholders_v1',
'automation_marketplace_manifest_keys_v1',
'automation_marketplace_dependency_contract_errors_v1',
'automation_marketplace_validate_manifest_v1',
'automation_marketplace_unique_workflow_name_v1',
'automation_marketplace_snapshot_workflow_template_v1',
'automation_marketplace_capture_workflow_revision_v1',
'automation_marketplace_snapshot_integration_plugin_version_v1',
'automation_marketplace_sync_runtime_auth_config_v1',
'automation_asset_create_listing_v1',
'automation_asset_publish_version_v1',
'automation_asset_submit_review_v1',
'automation_asset_review_decide_v1',
'integration_connection_upsert_v1',
'integration_connection_test_v1',
'integration_connection_rotate_v1',
'integration_connection_revoke_v1',
'integration_connection_bind_install_v1',
'automation_asset_install_v1',
'automation_asset_upgrade_preview_v1',
'automation_asset_upgrade_apply_v1',
'automation_asset_fork_v1',
'automation_marketplace_resolve_install_payload_v1',
'automation_marketplace_connection_for_install_v1',
'automation_marketplace_bind_install_initial_v1',
'automation_marketplace_assert_bound_auth_refs_v1',
'automation_marketplace_assert_install_references_v1',
'automation_marketplace_install_context_v1',
'automation_marketplace_has_secret_material_v1',
'automation_marketplace_assert_activation_v1',
'automation_marketplace_activation_guard_v1'
  ])) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.identity);
  IF f.proname=ANY(ARRAY['automation_asset_create_listing_v1','automation_asset_publish_version_v1','automation_asset_submit_review_v1','automation_asset_review_decide_v1','integration_connection_upsert_v1','integration_connection_test_v1','integration_connection_rotate_v1','integration_connection_revoke_v1','integration_connection_bind_install_v1','automation_asset_install_v1','automation_asset_upgrade_preview_v1','automation_asset_upgrade_apply_v1','automation_asset_fork_v1']) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated,service_role',f.identity);
  ELSIF f.proname<>'automation_marketplace_bind_install_initial_v1' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.identity);
  END IF;
 END LOOP;
END;
$acl$;
COMMIT;
