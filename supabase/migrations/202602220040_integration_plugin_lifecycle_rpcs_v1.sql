-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S03,S09
-- Migration: Integration plugin lifecycle RPCs v1

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220040_integration_plugin_lifecycle_rpcs_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.integration_plugin_bindings
  DROP CONSTRAINT IF EXISTS integration_plugin_bindings_unique_scope;
ALTER TABLE public.integration_plugin_bindings
  DROP CONSTRAINT IF EXISTS integration_plugin_bindings_unique_scope_resource;
ALTER TABLE public.integration_plugin_bindings
  ADD CONSTRAINT integration_plugin_bindings_unique_scope_resource
  UNIQUE (
    plugin_version_id,
    scope_type,
    scope_id,
    binding_type,
    runtime_resource_type,
    runtime_resource_id
  );

-------------------------------------------------------------------------------
-- 1) Helper functions
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_hash_payload_v1(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT encode(extensions.digest(COALESCE(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex');
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_resolve_policy_v1(
  p_category TEXT,
  p_organization_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
BEGIN
  IF p_organization_id IS NOT NULL THEN
    v_policy := public.resolve_settings(p_category, 'tenant', p_organization_id);
  END IF;

  IF v_policy IS NULL THEN
    v_policy := public.resolve_settings(p_category, 'global', NULL);
  END IF;

  RETURN COALESCE(v_policy, '{}'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_next_version_no_v1(p_plugin_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COALESCE(MAX(v.version_no), 0) + 1
  FROM public.integration_plugin_versions v
  WHERE v.plugin_id = p_plugin_id;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_normalize_key_v1(p_input TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_key TEXT := lower(COALESCE(p_input, ''));
BEGIN
  v_key := regexp_replace(v_key, '[^a-z0-9]+', '-', 'g');
  v_key := regexp_replace(v_key, '(^-+|-+$)', '', 'g');

  IF v_key = '' THEN
    v_key := 'plugin';
  END IF;

  RETURN left(v_key, 80);
END;
$function$;

-------------------------------------------------------------------------------
-- 2) RPC: generate draft (create plugin and/or new version)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_generate_draft_v1(
  p_plugin_name TEXT,
  p_plugin_kind TEXT,
  p_source_type TEXT DEFAULT 'manual',
  p_source_payload JSONB DEFAULT '{}'::jsonb,
  p_inbound_config JSONB DEFAULT '{}'::jsonb,
  p_mapping_config JSONB DEFAULT '{}'::jsonb,
  p_workflow_binding JSONB DEFAULT '{}'::jsonb,
  p_outbound_operations JSONB DEFAULT '[]'::jsonb,
  p_plugin_id UUID DEFAULT NULL,
  p_plugin_key TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_organization_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_org_id UUID;
  v_plugin public.integration_plugins%ROWTYPE;
  v_plugin_id UUID;
  v_plugin_key TEXT;
  v_version_no INTEGER;
  v_version_id UUID;
  v_counter INT := 1;
BEGIN
  v_org_id := COALESCE(p_organization_id, public.current_user_org_id());

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires tenant organization context';
  END IF;

  IF NOT public.is_platform_user() AND p_organization_id IS NOT NULL AND p_organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 cannot create drafts for another organization';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write', 'tenant', v_org_id);

  IF p_plugin_kind IS NULL OR btrim(p_plugin_kind) = '' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires plugin_kind';
  END IF;

  IF p_plugin_name IS NULL OR btrim(p_plugin_name) = '' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires plugin_name';
  END IF;

  IF p_plugin_id IS NOT NULL THEN
    SELECT *
      INTO v_plugin
      FROM public.integration_plugins p
     WHERE p.id = p_plugin_id
     LIMIT 1;

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
      lower(btrim(p_plugin_kind)),
      'draft',
      'integration_plugin',
      COALESCE(p_metadata, '{}'::jsonb),
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
    COALESCE(p_source_payload, '{}'::jsonb),
    COALESCE(p_inbound_config, '{}'::jsonb),
    COALESCE(p_mapping_config, '{}'::jsonb),
    COALESCE(p_workflow_binding, '{}'::jsonb),
    COALESCE(p_outbound_operations, '[]'::jsonb),
    '{}'::jsonb,
    COALESCE(p_metadata, '{}'::jsonb),
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
    'version_no', v_version_no,
    'organization_id', v_org_id
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 3) RPC: validate
-------------------------------------------------------------------------------

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
    v_errors := v_errors || 'workflow_binding requires template_name or valid template_id';
  END IF;

  IF v_template_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workflow_templates wt WHERE wt.name = v_template_name AND wt.status = 'active'
  ) THEN
    v_errors := v_errors || format('workflow template %s is not active or missing', v_template_name);
  END IF;

  IF lower(v_plugin.plugin_kind) = 'api' THEN
    v_route := COALESCE(v_version.inbound_config->'route', '{}'::jsonb);

    IF NULLIF(COALESCE(v_route->>'method', ''), '') IS NULL THEN
      v_errors := v_errors || 'api inbound_config.route.method is required';
    END IF;

    IF NULLIF(COALESCE(v_route->>'path_template', ''), '') IS NULL THEN
      v_errors := v_errors || 'api inbound_config.route.path_template is required';
    END IF;
  ELSIF lower(v_plugin.plugin_kind) = 'webhook' THEN
    v_webhook := COALESCE(v_version.inbound_config->'webhook', '{}'::jsonb);

    IF NULLIF(COALESCE(v_webhook->>'source_identifier', ''), '') IS NULL
       AND NULLIF(COALESCE(v_webhook->>'name', ''), '') IS NULL THEN
      v_warnings := v_warnings || 'webhook source identifier/name not provided; activation will generate one';
    END IF;
  ELSE
    v_errors := v_errors || format('unsupported plugin_kind=%s', v_plugin.plugin_kind);
  END IF;

  IF jsonb_typeof(COALESCE(v_version.outbound_operations, '[]'::jsonb)) <> 'array' THEN
    v_errors := v_errors || 'outbound_operations must be an array';
  ELSE
    v_ops := COALESCE(v_version.outbound_operations, '[]'::jsonb);

    FOR v_op IN
      SELECT value
      FROM jsonb_array_elements(v_ops)
    LOOP
      v_idx := v_idx + 1;

      IF jsonb_typeof(v_op) <> 'object' THEN
        v_errors := v_errors || format('outbound_operations[%s] must be an object', v_idx);
        CONTINUE;
      END IF;

      IF NULLIF(COALESCE(v_op->>'operation_name', ''), '') IS NULL THEN
        v_errors := v_errors || format('outbound_operations[%s].operation_name is required', v_idx);
      END IF;

      IF NULLIF(COALESCE(v_op->>'method', ''), '') IS NULL THEN
        v_errors := v_errors || format('outbound_operations[%s].method is required', v_idx);
      END IF;

      IF NULLIF(COALESCE(v_op->>'url_template', ''), '') IS NULL THEN
        v_errors := v_errors || format('outbound_operations[%s].url_template is required', v_idx);
      END IF;

      IF NULLIF(COALESCE(v_op->>'url_template', ''), '') IS NOT NULL
         AND lower(v_op->>'url_template') !~ '^https://'
      THEN
        v_errors := v_errors || format('outbound_operations[%s].url_template must use https://', v_idx);
      END IF;

      v_auth_mode := NULLIF(COALESCE(v_op #>> '{auth,mode}', ''), '');
      IF v_auth_mode IS NOT NULL AND array_length(v_allowed_auth_modes, 1) IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1
          FROM unnest(v_allowed_auth_modes) AS value
          WHERE lower(value) = lower(v_auth_mode)
        ) THEN
          v_errors := v_errors || format('outbound_operations[%s].auth.mode=%s is not allowed by policy', v_idx, v_auth_mode);
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF p_allow_external_side_effects AND COALESCE((v_security_policy #>> '{preview,allow_external_side_effects}')::BOOLEAN, FALSE) = FALSE THEN
    v_errors := v_errors || 'preview side effects are blocked by integration_plugin_security_policy.preview.allow_external_side_effects=false';
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

-------------------------------------------------------------------------------
-- 4) RPC: submit
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_submit_v1(
  p_plugin_version_id UUID,
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
  v_validation JSONB;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_submit_v1 requires plugin_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_submit_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_submit_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write', 'tenant', v_plugin.organization_id);

  IF v_version.status NOT IN ('draft', 'rejected') THEN
    RAISE EXCEPTION 'integration_plugin_submit_v1 requires draft/rejected status (current=%)', v_version.status;
  END IF;

  v_validation := public.integration_plugin_validate_v1(v_version.id, '{}'::jsonb, FALSE);

  IF COALESCE((v_validation->>'ok')::BOOLEAN, FALSE) IS FALSE THEN
    RAISE EXCEPTION 'integration_plugin_submit_v1 validation failed'
      USING DETAIL = v_validation::text;
  END IF;

  UPDATE public.integration_plugin_versions
     SET status = 'submitted',
         submitted_at = now(),
         submitted_by = auth.uid(),
         approval_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_version.id;

  UPDATE public.integration_plugins
     SET status = 'submitted',
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
    'submitted',
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
    NULL,
    jsonb_build_object('validation', v_validation)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'status', 'submitted'
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 5) RPC: approve / reject
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_approve_v1(
  p_plugin_version_id UUID,
  p_decision TEXT,
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
  v_decision TEXT := lower(COALESCE(NULLIF(btrim(p_decision), ''), ''));
  v_action TEXT;
  v_diff_hash TEXT;
  v_artifact_hash TEXT;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_approve_v1 requires plugin_version_id';
  END IF;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'integration_plugin_approve_v1 decision must be approved|rejected';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_approve_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_approve_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.approve', 'tenant', v_plugin.organization_id);

  IF v_decision = 'approved' AND v_version.status = 'approved' THEN
    RETURN jsonb_build_object('ok', TRUE, 'already_processed', TRUE, 'status', 'approved');
  ELSIF v_decision = 'rejected' AND v_version.status = 'rejected' THEN
    RETURN jsonb_build_object('ok', TRUE, 'already_processed', TRUE, 'status', 'rejected');
  END IF;

  IF v_version.status <> 'submitted' THEN
    RAISE EXCEPTION 'integration_plugin_approve_v1 requires submitted status (current=%)', v_version.status;
  END IF;

  v_diff_hash := public.integration_plugin_hash_payload_v1(
    jsonb_build_object(
      'normalized_contract', v_version.normalized_contract,
      'inbound_config', v_version.inbound_config,
      'mapping_config', v_version.mapping_config,
      'workflow_binding', v_version.workflow_binding,
      'outbound_operations', v_version.outbound_operations
    )
  );

  v_artifact_hash := public.integration_plugin_hash_payload_v1(
    jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'version_no', v_version.version_no,
      'kind', v_plugin.plugin_kind,
      'submitted_at', v_version.submitted_at
    )
  );

  IF v_decision = 'approved' THEN
    UPDATE public.integration_plugin_versions
       SET status = 'approved',
           approved_at = now(),
           approved_by = auth.uid(),
           approval_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
           diff_hash = v_diff_hash,
           artifact_hash = v_artifact_hash,
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = v_version.id;

    UPDATE public.integration_plugins
       SET status = 'approved',
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = v_plugin.id;

    v_action := 'approved';
  ELSE
    UPDATE public.integration_plugin_versions
       SET status = 'rejected',
           approved_at = now(),
           approved_by = auth.uid(),
           approval_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
           diff_hash = v_diff_hash,
           artifact_hash = v_artifact_hash,
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = v_version.id;

    UPDATE public.integration_plugins
       SET status = 'draft',
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = v_plugin.id;

    v_action := 'rejected';
  END IF;

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
    v_action,
    auth.uid(),
    NULLIF(btrim(COALESCE(p_reason, '')), ''),
    v_diff_hash,
    v_artifact_hash,
    jsonb_build_object('decision', v_action)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'status', v_action,
    'diff_hash', v_diff_hash,
    'artifact_hash', v_artifact_hash
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 6) RPC: activate
-------------------------------------------------------------------------------

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

  IF v_version.status = 'active' AND v_plugin.active_version_id = v_version.id THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'already_active', TRUE,
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id
    );
  END IF;

  IF v_version.status <> 'approved' THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 requires approved status (current=%)', v_version.status;
  END IF;

  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_id IS NULL AND v_scope_type = 'tenant' THEN
    v_scope_id := v_plugin.organization_id;
  END IF;

  IF NOT public.integration_plugin_scope_belongs_org_v1(v_scope_type, v_scope_id, v_plugin.organization_id) THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 invalid scope %/% for organization %', v_scope_type, v_scope_id, v_plugin.organization_id;
  END IF;

  v_workflow_template_name := public.integration_plugin_resolve_template_name_v1(COALESCE(v_version.workflow_binding, '{}'::jsonb));

  IF v_workflow_template_name IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 requires valid workflow binding before activation';
  END IF;

  SELECT wt.id
    INTO v_workflow_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = v_workflow_template_name
     AND wt.status = 'active'
   ORDER BY wt.updated_at DESC
   LIMIT 1;

  IF v_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 workflow template % missing/inactive', v_workflow_template_name;
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

-------------------------------------------------------------------------------
-- 7) RPC: rotate credentials
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_rotate_credentials_v1(
  p_plugin_version_id UUID,
  p_auth_type TEXT,
  p_credentials JSONB,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
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
  v_provider_binding public.integration_plugin_bindings%ROWTYPE;
  v_auth_config_id UUID;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires plugin_version_id';
  END IF;

  IF p_auth_type IS NULL OR btrim(p_auth_type) = '' THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires auth_type';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  SELECT * INTO v_provider_binding
  FROM public.integration_plugin_bindings b
  WHERE b.plugin_version_id = v_version.id
    AND b.binding_type = 'provider'
    AND b.runtime_resource_type = 'providers'
    AND b.enabled = TRUE
  ORDER BY b.created_at DESC
  LIMIT 1;

  IF v_provider_binding.id IS NULL OR v_provider_binding.runtime_resource_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_rotate_credentials_v1 requires active provider binding';
  END IF;

  INSERT INTO public.provider_auth_configs (
    provider_id,
    auth_type,
    credentials,
    expires_at
  )
  VALUES (
    v_provider_binding.runtime_resource_id,
    btrim(p_auth_type),
    COALESCE(p_credentials, '{}'::jsonb),
    p_expires_at
  )
  RETURNING id INTO v_auth_config_id;

  UPDATE public.integration_plugin_versions
     SET auth_bindings = jsonb_set(
           jsonb_set(COALESCE(auth_bindings, '{}'::jsonb), '{latest_auth_config_id}', to_jsonb(v_auth_config_id::text), TRUE),
           '{latest_auth_type}',
           to_jsonb(btrim(p_auth_type)),
           TRUE
         ),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_version.id;

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
    'rotated_credentials',
    auth.uid(),
    NULLIF(btrim(COALESCE(p_reason, '')), ''),
    NULL,
    NULL,
    jsonb_build_object(
      'provider_id', v_provider_binding.runtime_resource_id,
      'auth_config_id', v_auth_config_id,
      'auth_type', btrim(p_auth_type)
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'provider_id', v_provider_binding.runtime_resource_id,
    'auth_config_id', v_auth_config_id
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 8) RPC: export handoff
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_export_handoff_v1(
  p_plugin_version_id UUID,
  p_base_url TEXT DEFAULT NULL
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
  v_source_binding public.integration_plugin_bindings%ROWTYPE;
  v_route_binding public.integration_plugin_bindings%ROWTYPE;
  v_route public.api_routes%ROWTYPE;
  v_base_url TEXT;
  v_token TEXT;
  v_endpoint TEXT;
  v_route_path TEXT;
  v_route_method TEXT;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 requires plugin_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_export_handoff_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.read', 'tenant', v_plugin.organization_id);

  SELECT * INTO v_source_binding
  FROM public.integration_plugin_bindings b
  WHERE b.plugin_version_id = v_version.id
    AND b.binding_type = 'webhook_source'
    AND b.enabled = TRUE
  ORDER BY b.created_at DESC
  LIMIT 1;

  SELECT * INTO v_route_binding
  FROM public.integration_plugin_bindings b
  WHERE b.plugin_version_id = v_version.id
    AND b.binding_type = 'api_route'
    AND b.enabled = TRUE
  ORDER BY b.created_at DESC
  LIMIT 1;

  v_base_url := regexp_replace(COALESCE(NULLIF(btrim(COALESCE(p_base_url, '')), ''), '{{BASE_URL}}'), '/+$', '');
  v_token := COALESCE(v_source_binding.activation_payload->>'issued_token', '{{TOKEN}}');

  IF lower(v_plugin.plugin_kind) = 'api' THEN
    IF v_route_binding.runtime_resource_id IS NOT NULL THEN
      SELECT * INTO v_route
      FROM public.api_routes r
      WHERE r.id = v_route_binding.runtime_resource_id
      LIMIT 1;

      v_route_path := COALESCE(v_route.path_template, '{{PATH_TEMPLATE}}');
      v_route_method := COALESCE(v_route.method, 'POST');
    ELSE
      v_route_path := '{{PATH_TEMPLATE}}';
      v_route_method := 'POST';
    END IF;

    v_endpoint := format('%s/functions/v1/api-gateway/t/%s%s', v_base_url, v_token, v_route_path);

    RETURN jsonb_build_object(
      'ok', TRUE,
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'kind', 'api',
      'endpoint', v_endpoint,
      'method', v_route_method,
      'token', v_token,
      'instructions', jsonb_build_array(
        'Replace your upstream base URL with endpoint base.',
        'Keep request body and headers mapping per plugin contract.',
        'Use issued token in path (/t/{token}/...) or Authorization Bearer token flow supported by gateway.'
      ),
      'sample_curl', format('curl -X %s "%s" -H "content-type: application/json" -d ''{}''', v_route_method, v_endpoint)
    );
  END IF;

  v_endpoint := format('%s/functions/v1/webhook-receiver', v_base_url);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'kind', 'webhook',
    'endpoint', v_endpoint,
    'token', v_token,
    'headers', jsonb_build_object('authorization', format('Bearer %s', v_token)),
    'instructions', jsonb_build_array(
      'Point webhook destination to endpoint.',
      'Send Authorization: Bearer {token}.',
      'Keep payload shape per plugin mapping configuration.'
    ),
    'sample_curl', format('curl -X POST "%s" -H "authorization: Bearer %s" -H "content-type: application/json" -d ''{}''', v_endpoint, v_token)
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 9) RPC: migration assistant (runtime assets -> plugin draft)
-------------------------------------------------------------------------------

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

-------------------------------------------------------------------------------
-- 10) Grants
-------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.integration_plugin_hash_payload_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_resolve_policy_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_next_version_no_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_normalize_key_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_generate_draft_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, UUID, TEXT, TEXT, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_validate_v1(UUID, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_submit_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_approve_v1(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_activate_v1(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_rotate_credentials_v1(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_export_handoff_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_migrate_runtime_assets_v1(TEXT, UUID, TEXT, JSONB) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.integration_plugin_hash_payload_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_resolve_policy_v1(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_next_version_no_v1(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_normalize_key_v1(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_generate_draft_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, JSONB, UUID, TEXT, TEXT, UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_validate_v1(UUID, JSONB, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_submit_v1(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_approve_v1(UUID, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_activate_v1(UUID, TEXT, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_rotate_credentials_v1(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_export_handoff_v1(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_migrate_runtime_assets_v1(TEXT, UUID, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602220040_integration_plugin_lifecycle_rpcs_v1'));
COMMIT;
