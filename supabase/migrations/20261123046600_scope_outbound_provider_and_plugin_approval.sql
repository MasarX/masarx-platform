-- Scope outbound provider and plugin approval to the caller's organization.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.enqueue_comms_attempt_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_user_org_id UUID := public.current_user_org_id();
  v_shipment_id UUID := NULL;
  v_shipment public.shipments%ROWTYPE;
  v_channel TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'channel', '')), ''));
  v_call_type TEXT := NULL;
  v_template_id UUID := NULL;
  v_template_key TEXT := NULL;
  v_template public.message_templates%ROWTYPE;
  v_message_text TEXT := NULL;
  v_recipient public.recipients%ROWTYPE;
  v_recipient_override JSONB := COALESCE(v_args->'recipient_override', '{}'::jsonb);
  v_correlation_id UUID := gen_random_uuid();
  v_policy JSONB := '{}'::jsonb;
  v_allowed_channels JSONB := '[]'::jsonb;
  v_allow_operator BOOLEAN := FALSE;
  v_settings_resolution_id UUID := NULL;
  v_provider_id UUID := NULL;
  v_operation public.operation_templates%ROWTYPE;
  v_headers JSONB := '{}'::jsonb;
  v_body JSONB := '{}'::jsonb;
  v_render_context JSONB := '{}'::jsonb;
  v_outbound_call_id UUID := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('comms', 'write') THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 requires comms.write capability'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_shipment_id := NULLIF(v_args->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  BEGIN
    v_template_id := NULLIF(v_args->>'template_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_template_id := NULL;
  END;

  v_template_key := NULLIF(btrim(COALESCE(v_args->>'template_key', '')), '');
  v_message_text := NULLIF(COALESCE(v_args->>'message_text', ''), '');

  IF v_shipment_id IS NULL OR v_channel IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'invalid_request')
    );
  END IF;

  SELECT *
    INTO v_shipment
    FROM public.shipments s
   WHERE s.id = v_shipment_id
     AND (
       public.is_platform_user()
       OR (
         v_scope_type = 'tenant'
         AND s.organization_id = v_user_org_id
       )
       OR (
         v_scope_type = 'client'
         AND s.client_id = v_scope_id
       )
       OR (
         v_scope_type = 'sender'
         AND s.sender_id = v_scope_id
       )
     )
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 forbidden or shipment not found: %', v_shipment_id
      USING ERRCODE = '42501';
  END IF;

  SELECT r.*
    INTO v_recipient
    FROM public.recipients r
   WHERE r.id = v_shipment.recipient_id
   LIMIT 1;

  SELECT rp.value, rp.settings_version_id
    INTO v_policy, v_settings_resolution_id
    FROM public.resolve_communication_policy(
      jsonb_build_object(
        'organization_id', v_shipment.organization_id,
        'client_id', v_shipment.client_id,
        'sender_id', v_shipment.sender_id,
        'shipment_id', v_shipment.id
      )
    ) AS rp
   LIMIT 1;

  v_policy := COALESCE(v_policy, '{}'::jsonb);
  v_allowed_channels := COALESCE(v_policy->'allowed_channels', '[]'::jsonb);

  BEGIN
    v_allow_operator := COALESCE(NULLIF(v_policy->>'allow_operator_initiated_send', '')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_allow_operator := FALSE;
  END;

  IF v_allow_operator IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code', 'comms_operator_initiated_disabled',
        'policy_key', 'communication_policy.allow_operator_initiated_send'
      ),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  IF jsonb_typeof(v_allowed_channels) <> 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(v_allowed_channels) AS ch(value)
       WHERE lower(ch.value) = v_channel
     ) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code', 'comms_channel_not_allowed',
        'channel', v_channel,
        'allowed_channels', v_allowed_channels
      ),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  v_call_type := CASE v_channel
    WHEN 'sms' THEN 'comms_sms'
    WHEN 'whatsapp' THEN 'comms_whatsapp'
    WHEN 'email' THEN 'comms_email'
    WHEN 'voice' THEN 'comms_voice'
    WHEN 'call' THEN 'comms_voice'
    ELSE NULL
  END;

  IF v_call_type IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'comms_channel_not_supported', 'channel', v_channel),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  BEGIN
    v_provider_id := NULLIF(v_args->>'provider_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_provider_id := NULL;
  END;

  IF v_provider_id IS NULL THEN
    BEGIN
      v_provider_id := NULLIF(v_policy #>> ARRAY['operator_initiated', v_channel, 'provider_id'], '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_provider_id := NULL;
    END;
  END IF;

  IF v_provider_id IS NULL THEN
    SELECT p.id
      INTO v_provider_id
      FROM public.providers p
      JOIN public.operation_templates ot
        ON ot.provider_id = p.id
     WHERE p.organization_id = v_shipment.organization_id
       AND p.provider_type = 'comms'
       AND p.enabled IS TRUE
       AND ot.call_type = v_call_type
     ORDER BY p.priority_rank DESC, p.updated_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  IF v_provider_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'comms_provider_missing', 'channel', v_channel),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.providers p
    WHERE p.id = v_provider_id
      AND p.organization_id = v_shipment.organization_id
  ) THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 provider is outside shipment organization'
      USING ERRCODE = '42501';
  END IF;

  SELECT ot.*
    INTO v_operation
    FROM public.operation_templates ot
    JOIN public.providers p ON p.id = ot.provider_id
   WHERE ot.provider_id = v_provider_id
     AND p.organization_id = v_shipment.organization_id
     AND ot.call_type = v_call_type
   ORDER BY ot.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_operation.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'comms_operation_template_missing', 'channel', v_channel),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  IF v_template_id IS NULL AND v_template_key IS NULL THEN
    SELECT item.value
      INTO v_template_key
      FROM jsonb_array_elements_text(COALESCE(v_policy->'templates', '[]'::jsonb)) AS item(value)
     LIMIT 1;
  END IF;

  SELECT mt.*
    INTO v_template
    FROM public.message_templates mt
   WHERE mt.organization_id = v_shipment.organization_id
     AND mt.archived IS DISTINCT FROM TRUE
     AND (
       (v_template_id IS NOT NULL AND mt.id = v_template_id)
       OR (
         v_template_id IS NULL
         AND v_template_key IS NOT NULL
         AND mt.template_name = v_template_key
       )
     )
   ORDER BY mt.updated_at DESC NULLS LAST
   LIMIT 1;

  v_render_context := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_shipment.id,
    'tracking_number', v_shipment.tracking_number,
    'client_reference_number', v_shipment.client_reference_number,
    'carrier_reference_number', v_shipment.carrier_reference_number,
    'recipient_name', v_recipient.name,
    'recipient_phone', COALESCE(v_recipient_override->>'phone_number', v_recipient.phone_number),
    'channel', v_channel
  ));

  IF v_message_text IS NULL AND v_template.id IS NOT NULL THEN
    v_template_id := v_template.id;
    v_message_text := trim(both '"' FROM public.render_template(to_jsonb(v_template.body_template), v_render_context)::text);
  END IF;

  IF v_message_text IS NULL OR btrim(v_message_text) = '' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'comms_template_missing', 'channel', v_channel),
      'correlation_id', v_correlation_id::text
    );
  END IF;

  v_render_context := jsonb_strip_nulls(v_render_context || jsonb_build_object(
    'message_text', v_message_text,
    'template_id', v_template_id
  ));

  IF v_operation.headers_template IS NOT NULL THEN
    v_headers := COALESCE(public.render_template(v_operation.headers_template, v_render_context), '{}'::jsonb);
  END IF;

  IF v_operation.body_template IS NOT NULL THEN
    v_body := COALESCE(public.render_template(v_operation.body_template, v_render_context), '{}'::jsonb);
  ELSE
    v_body := jsonb_strip_nulls(jsonb_build_object(
      'message_text', v_message_text,
      'template_id', v_template_id,
      'recipient', jsonb_strip_nulls(jsonb_build_object(
        'id', v_recipient.id,
        'phone_number', COALESCE(v_recipient_override->>'phone_number', v_recipient.phone_number),
        'email', COALESCE(v_recipient_override->>'email', v_recipient.email)
      ))
    ));
  END IF;

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    priority,
    max_retries,
    correlation_id,
    shipment_id,
    context
  )
  VALUES (
    v_call_type,
    'provider',
    v_provider_id,
    v_operation.method,
    v_operation.url_template,
    COALESCE(v_headers, '{}'::jsonb),
    COALESCE(v_body, '{}'::jsonb),
    100,
    3,
    v_correlation_id,
    v_shipment.id,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'console.shipments_drawer.send_now',
      'requested_by_user_id', v_user_id,
      'recipient_id', v_recipient.id,
      'client_id', v_shipment.client_id,
      'sender_id', v_shipment.sender_id,
      'channel', v_channel,
      'template_id', v_template_id,
      'operation_template_id', v_operation.id,
      'settings_resolution_id', v_settings_resolution_id
    ))
  )
  RETURNING id INTO v_outbound_call_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'comms_attempt_id', v_outbound_call_id,
    'outbound_call_id', v_outbound_call_id,
    'shipment_id', v_shipment.id,
    'channel', v_channel,
    'template_id', v_template_id,
    'status', 'queued',
    'correlation_id', v_correlation_id::text,
    'settings_resolution_id', v_settings_resolution_id
  );
END;
$function$;

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
    RAISE EXCEPTION 'Capability denied: integration_plugins.approve' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.approve' USING ERRCODE = '42501';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.approve' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'Capability denied: integration_plugins.write' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.write' USING ERRCODE = '42501';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.write' USING ERRCODE = '42501';
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
  v_egress_policy JSONB;
  v_enforce_https_only BOOLEAN := TRUE;
  v_http_allowed_hosts TEXT[] := ARRAY[]::TEXT[];
  v_url_host TEXT;
  v_allowed_http_host TEXT;
  v_allowed_http BOOLEAN;
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
    RAISE EXCEPTION 'Capability denied: integration_plugins.test' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.test' USING ERRCODE = '42501';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.test' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.test', 'tenant', v_plugin.organization_id);

  v_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_policy', v_plugin.organization_id);
  v_security_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_security_policy', v_plugin.organization_id);
  v_egress_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_egress_policy', v_plugin.organization_id);
  v_enforce_https_only := COALESCE((v_egress_policy->>'enforce_https_only')::BOOLEAN, TRUE);

  SELECT COALESCE(array_agg(lower(host_value)), ARRAY[]::TEXT[])
    INTO v_http_allowed_hosts
    FROM jsonb_array_elements_text(COALESCE(v_egress_policy->'http_allowed_hosts', '[]'::jsonb)) AS host_value;

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
        v_url_host := lower(COALESCE(substring(v_op->>'url_template' FROM '^https?://([^/:]+)'), ''));
        v_allowed_http := FALSE;
        FOREACH v_allowed_http_host IN ARRAY v_http_allowed_hosts
        LOOP
          IF v_allowed_http_host = v_url_host THEN
            v_allowed_http := TRUE;
            EXIT;
          END IF;
        END LOOP;

        IF v_enforce_https_only IS TRUE AND v_allowed_http IS FALSE THEN
          v_errors := array_append(
            v_errors,
            format('outbound_operations[%s].url_template must use https:// or an integration_plugin_egress_policy.http_allowed_hosts entry', v_idx)
          );
        END IF;
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
  v_credentials_vault_id UUID;
  v_secret_name TEXT;
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
    RAISE EXCEPTION 'Capability denied: integration_plugins.activate' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.activate' USING ERRCODE = '42501';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.activate' USING ERRCODE = '42501';
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

  v_auth_config_id := gen_random_uuid();
  v_secret_name := format('provider_auth_configs/%s', v_auth_config_id);
  SELECT vault.create_secret(
    COALESCE(p_credentials, '{}'::jsonb)::text,
    v_secret_name,
    format('Console V2 integration plugin credential rotation %s', v_auth_config_id),
    NULL
  )
    INTO v_credentials_vault_id;

  INSERT INTO public.provider_auth_configs (
    id,
    provider_id,
    auth_type,
    credentials,
    credentials_vault_id,
    expires_at
  )
  VALUES (
    v_auth_config_id,
    v_provider_binding.runtime_resource_id,
    btrim(p_auth_type),
    NULL,
    v_credentials_vault_id,
    p_expires_at
  );

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
      'auth_type', btrim(p_auth_type),
      'credentials_vault_id', v_credentials_vault_id
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'provider_id', v_provider_binding.runtime_resource_id,
    'auth_config_id', v_auth_config_id,
    'provider_auth_config_id', v_auth_config_id,
    'credentials_vaulted', true
  );
END;
$function$;

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
    RAISE EXCEPTION 'Capability denied: integration_plugins.activate' USING ERRCODE = '42501';
  END IF;

  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.activate' USING ERRCODE = '42501';
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

COMMIT;
