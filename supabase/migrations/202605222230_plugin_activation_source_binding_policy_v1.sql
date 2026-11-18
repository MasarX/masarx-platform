-- Console V2 Plugin Studio API activations must not create shipment-create
-- runtime sources that the API Gateway will later reject for missing sender
-- context. Resolve required source bindings from integration_plugin_policy.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605222230_plugin_activation_source_binding_policy_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $policy$
DECLARE
  v_setting RECORD;
  v_source_binding JSONB := jsonb_build_object(
    'api', jsonb_build_object(
      'enabled', TRUE,
      'required_for_templates', jsonb_build_array('api_gateway_shipment_create_default_v1'),
      'required_for_intents', jsonb_build_array('shipment.create', 'shipment_create', 'shipments.create'),
      'resolution_order', jsonb_build_array(
        'scope_sender',
        'scope_client_default_sender',
        'scope_client_first_active_sender',
        'tenant_default_sender',
        'tenant_first_active_sender'
      ),
      'default_sender_name_source', 'saas_onboarding_policy.client_defaults.default_sender_name',
      'fallback_to_first_active_sender', TRUE
    )
  );
  v_workflow_binding JSONB := jsonb_build_object(
    'api', jsonb_build_object(
      'mode', 'attach_existing',
      'template_name', 'api_gateway_shipment_create_default_v1',
      'intent', 'shipment.create'
    )
  );
  v_value JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.scope_type, s.scope_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
  LOOP
    v_value := COALESCE(v_setting.cached_value, '{}'::jsonb)
      || jsonb_build_object('studio_defaults', COALESCE(v_setting.cached_value->'studio_defaults', '{}'::jsonb));
    v_value := jsonb_set(
      v_value,
      '{studio_defaults,source_binding,api}',
      COALESCE(v_setting.cached_value #> '{studio_defaults,source_binding,api}', '{}'::jsonb)
        || (v_source_binding->'api'),
      TRUE
    );
    v_value := jsonb_set(
      v_value,
      '{studio_defaults,workflow_bindings,api}',
      COALESCE(v_setting.cached_value #> '{studio_defaults,workflow_bindings,api}', '{}'::jsonb)
        || (v_workflow_binding->'api'),
      TRUE
    );

    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      v_setting.scope_type,
      v_setting.scope_id,
      v_value,
      1,
      'Console V2 Plugin Studio source binding defaults'
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      'global',
      NULL,
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'studio_defaults', jsonb_build_object(
          'source_binding', v_source_binding,
          'workflow_bindings', v_workflow_binding
        )
      ),
      1,
      'Console V2 Plugin Studio source binding defaults'
    );
  END IF;
END;
$policy$;

CREATE OR REPLACE FUNCTION public.integration_plugin_activation_requires_source_sender_v1(
  p_plugin_kind TEXT,
  p_workflow_binding JSONB,
  p_policy JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_kind TEXT := lower(COALESCE(NULLIF(btrim(p_plugin_kind), ''), ''));
  v_source_policy JSONB;
  v_template_name TEXT;
  v_intent TEXT;
BEGIN
  IF v_kind = '' THEN
    RETURN FALSE;
  END IF;

  v_source_policy := COALESCE(p_policy #> ARRAY['studio_defaults', 'source_binding', v_kind], '{}'::jsonb);
  IF jsonb_typeof(v_source_policy) <> 'object'
     OR COALESCE((v_source_policy->>'enabled')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN FALSE;
  END IF;

  v_template_name := public.integration_plugin_resolve_template_name_v1(COALESCE(p_workflow_binding, '{}'::jsonb));
  v_intent := lower(NULLIF(btrim(COALESCE(
    p_workflow_binding #>> '{workflow,intent}',
    p_workflow_binding #>> '{intent}',
    p_workflow_binding #>> '{canonical_intent}'
  )), ''));

  IF v_template_name IS NOT NULL
     AND COALESCE(v_source_policy->'required_for_templates', '[]'::jsonb) ? v_template_name THEN
    RETURN TRUE;
  END IF;

  IF v_intent IS NOT NULL
     AND COALESCE(v_source_policy->'required_for_intents', '[]'::jsonb) ? v_intent THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_activation_requires_source_sender_v1(TEXT, JSONB, JSONB)
  IS 'Resolves whether a Plugin Studio activation requires a real sender/client-bound source from integration_plugin_policy.studio_defaults.source_binding.';

REVOKE ALL ON FUNCTION public.integration_plugin_activation_requires_source_sender_v1(TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_activation_requires_source_sender_v1(TEXT, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.integration_plugin_activation_requires_source_sender_v1(TEXT, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.integration_plugin_activation_requires_source_sender_v1(TEXT, JSONB, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.integration_plugin_resolve_activation_sender_v1(
  p_plugin_version_id UUID,
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_scope_type), ''), 'tenant'));
  v_scope_id UUID := p_scope_id;
  v_policy JSONB;
  v_source_policy JSONB;
  v_required BOOLEAN;
  v_resolution_order JSONB;
  v_resolution TEXT;
  v_default_sender_name TEXT;
  v_sender_id UUID;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_resolve_activation_sender_v1 requires plugin_version_id';
  END IF;

  SELECT * INTO v_version
    FROM public.integration_plugin_versions
   WHERE id = p_plugin_version_id
   LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_resolve_activation_sender_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_version.plugin_id
   LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_resolve_activation_sender_v1 plugin % not found', v_version.plugin_id;
  END IF;

  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;
  IF v_scope_id IS NULL AND v_scope_type = 'tenant' THEN
    v_scope_id := v_plugin.organization_id;
  END IF;

  v_policy := public.integration_plugin_resolve_policy_v1('integration_plugin_policy', v_plugin.organization_id);
  v_required := public.integration_plugin_activation_requires_source_sender_v1(
    v_plugin.plugin_kind,
    COALESCE(v_version.workflow_binding, '{}'::jsonb),
    v_policy
  );

  IF v_required IS FALSE THEN
    IF v_scope_type = 'sender' THEN
      RETURN v_scope_id;
    END IF;
    RETURN NULL;
  END IF;

  v_source_policy := COALESCE(v_policy #> ARRAY['studio_defaults', 'source_binding', lower(v_plugin.plugin_kind)], '{}'::jsonb);
  v_resolution_order := COALESCE(v_source_policy->'resolution_order', '[]'::jsonb);
  IF jsonb_typeof(v_resolution_order) <> 'array' OR jsonb_array_length(v_resolution_order) = 0 THEN
    v_resolution_order := jsonb_build_array('scope_sender', 'scope_client_default_sender', 'scope_client_first_active_sender', 'tenant_default_sender', 'tenant_first_active_sender');
  END IF;

  v_default_sender_name := NULLIF(
    btrim(COALESCE(public.resolve_saas_onboarding_policy_v1() #>> '{client_defaults,default_sender_name}', '')),
    ''
  );

  FOR v_resolution IN
    SELECT value
      FROM jsonb_array_elements_text(v_resolution_order)
  LOOP
    v_sender_id := NULL;

    IF v_resolution = 'scope_sender' AND v_scope_type = 'sender' THEN
      SELECT s.id
        INTO v_sender_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_scope_id
         AND c.organization_id = v_plugin.organization_id
         AND COALESCE(s.status, 'active') = 'active'
         AND COALESCE(c.status, 'active') = 'active'
       LIMIT 1;
    ELSIF v_resolution = 'scope_client_default_sender' AND v_scope_type = 'client' THEN
      SELECT s.id
        INTO v_sender_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE c.id = v_scope_id
         AND c.organization_id = v_plugin.organization_id
         AND COALESCE(s.status, 'active') = 'active'
         AND COALESCE(c.status, 'active') = 'active'
       ORDER BY
         CASE WHEN v_default_sender_name IS NOT NULL AND s.name = v_default_sender_name THEN 0 ELSE 1 END,
         s.created_at ASC,
         s.id ASC
       LIMIT 1;
    ELSIF v_resolution = 'scope_client_first_active_sender' AND v_scope_type = 'client' THEN
      SELECT s.id
        INTO v_sender_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE c.id = v_scope_id
         AND c.organization_id = v_plugin.organization_id
         AND COALESCE(s.status, 'active') = 'active'
         AND COALESCE(c.status, 'active') = 'active'
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT 1;
    ELSIF v_resolution = 'tenant_default_sender' AND v_scope_type IN ('tenant', 'global') THEN
      SELECT s.id
        INTO v_sender_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE c.organization_id = v_plugin.organization_id
         AND COALESCE(s.status, 'active') = 'active'
         AND COALESCE(c.status, 'active') = 'active'
         AND (v_default_sender_name IS NULL OR s.name = v_default_sender_name)
       ORDER BY c.created_at ASC, s.created_at ASC, s.id ASC
       LIMIT 1;
    ELSIF v_resolution = 'tenant_first_active_sender' AND v_scope_type IN ('tenant', 'global') THEN
      SELECT s.id
        INTO v_sender_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE c.organization_id = v_plugin.organization_id
         AND COALESCE(s.status, 'active') = 'active'
         AND COALESCE(c.status, 'active') = 'active'
       ORDER BY c.created_at ASC, s.created_at ASC, s.id ASC
       LIMIT 1;
    END IF;

    IF v_sender_id IS NOT NULL THEN
      RETURN v_sender_id;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'integration_plugin_activate_core_v1 requires active sender/client source binding for plugin version % scope %/%',
    p_plugin_version_id, v_scope_type, v_scope_id
    USING ERRCODE = 'P0001';
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_resolve_activation_sender_v1(UUID, TEXT, UUID)
  IS 'Resolves required Plugin Studio runtime source sender binding from integration_plugin_policy and active tenant/client/sender context.';

REVOKE ALL ON FUNCTION public.integration_plugin_resolve_activation_sender_v1(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_resolve_activation_sender_v1(UUID, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.integration_plugin_resolve_activation_sender_v1(UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.integration_plugin_resolve_activation_sender_v1(UUID, TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.integration_plugin_activation_provider_base_url_v1(
  p_plugin_version_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_version public.integration_plugin_versions%ROWTYPE;
  v_url_template TEXT;
  v_base_url TEXT;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_version
    FROM public.integration_plugin_versions
   WHERE id = p_plugin_version_id
   LIMIT 1;

  IF v_version.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_base_url := NULLIF(btrim(v_version.inbound_config #>> '{route,upstream_base_url}'), '');
  IF v_base_url IS NOT NULL THEN
    RETURN rtrim(v_base_url, '/');
  END IF;

  SELECT NULLIF(btrim(op->>'url_template'), '')
    INTO v_url_template
    FROM jsonb_array_elements(COALESCE(v_version.outbound_operations, '[]'::jsonb)) op
   WHERE NULLIF(btrim(op->>'url_template'), '') IS NOT NULL
   LIMIT 1;

  IF v_url_template IS NULL THEN
    RETURN NULL;
  END IF;

  v_base_url := substring(v_url_template FROM '^(https?://[^/]+)');
  RETURN NULLIF(rtrim(COALESCE(v_base_url, ''), '/'), '');
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_activation_provider_base_url_v1(UUID)
  IS 'Resolves API plugin provider base_url from row-driven inbound_config.route.upstream_base_url or outbound_operations[].url_template.';

REVOKE ALL ON FUNCTION public.integration_plugin_activation_provider_base_url_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_activation_provider_base_url_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.integration_plugin_activation_provider_base_url_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.integration_plugin_activation_provider_base_url_v1(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.api_gateway_sanitize_outbound_headers_v1(p_headers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_out jsonb := '{}'::jsonb;
  v_entry record;
  v_key text;
  v_value text;
BEGIN
  FOR v_entry IN
    SELECT key, value
      FROM jsonb_each_text(COALESCE(p_headers, '{}'::jsonb))
  LOOP
    v_key := lower(btrim(v_entry.key));
    v_value := v_entry.value;

    IF v_key IS NULL OR v_key = '' THEN
      CONTINUE;
    END IF;

    IF v_key IN (
      'authorization',
      'proxy-authorization',
      'apikey',
      'x-api-key',
      'x-client-info',
      'idempotency-key',
      'x-idempotency-key',
      'x-webhook-token',
      'x-internal-edge-token',
      'connection',
      'content-length',
      'host',
      'keep-alive',
      'proxy-authenticate',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'accept',
      'accept-encoding',
      'accept-language',
      'origin',
      'referer',
      'user-agent',
      'traceparent',
      'tracestate',
      'baggage',
      'sentry-trace',
      'x-correlation-id',
      'x-request-id',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-user',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-path',
      'x-forwarded-port',
      'x-forwarded-prefix',
      'x-forwarded-proto',
      'x-original-uri',
      'x-real-ip',
      'x-rewrite-url',
      'x-envoy-original-path'
    ) THEN
      CONTINUE;
    END IF;

    IF v_value IS NULL OR btrim(v_value) = '' THEN
      CONTINUE;
    END IF;

    v_out := jsonb_set(v_out, ARRAY[v_key], to_jsonb(v_value), TRUE);
  END LOOP;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.api_gateway_sanitize_outbound_headers_v1(jsonb)
  IS 'Sanitizes provider-bound API Gateway headers by stripping auth, browser/proxy/runtime, and internal tracing headers before egress policy checks.';

DO $patch$
DECLARE
  v_def TEXT;
  v_declare_from TEXT := $from$  v_source_token TEXT;
  v_source_suffix INT := 1;
$from$;
  v_declare_to TEXT := $to$  v_source_token TEXT;
  v_source_suffix INT := 1;
  v_source_sender_id UUID := NULL;
  v_source_client_id UUID := NULL;
  v_source_binding_metadata JSONB := '{}'::jsonb;
$to$;
  v_assign_from TEXT := $from$  IF v_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 workflow template % missing/inactive', v_workflow_template_name;
  END IF;
$from$;
  v_assign_to TEXT := $to$  IF v_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 workflow template % missing/inactive', v_workflow_template_name;
  END IF;

  v_source_sender_id := public.integration_plugin_resolve_activation_sender_v1(v_version.id, v_scope_type, v_scope_id);
  IF v_source_sender_id IS NOT NULL THEN
    SELECT s.client_id
      INTO v_source_client_id
      FROM public.senders s
     WHERE s.id = v_source_sender_id
     LIMIT 1;
    v_source_binding_metadata := jsonb_strip_nulls(jsonb_build_object(
      'source_sender_id', v_source_sender_id,
      'source_client_id', v_source_client_id,
      'source_binding_source', 'integration_plugin_policy'
    ));
  END IF;
$to$;
  v_sender_from TEXT := $from$      CASE WHEN v_scope_type = 'sender' THEN v_scope_id ELSE NULL END,
$from$;
  v_sender_to TEXT := $to$      v_source_sender_id,
$to$;
  v_metadata_from TEXT := $from$    jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id)
$from$;
  v_metadata_to TEXT := $to$    jsonb_build_object('plugin_id', v_plugin.id, 'plugin_version_id', v_version.id) || v_source_binding_metadata
$to$;
  v_payload_from TEXT := $from$  v_binding_payload := jsonb_build_object(
    'source_identifier', v_source_identifier,
    'issued_token', v_source_token
  );
$from$;
  v_payload_to TEXT := $to$  v_binding_payload := jsonb_strip_nulls(jsonb_build_object(
    'source_identifier', v_source_identifier,
    'issued_token', v_source_token,
    'source_sender_id', v_source_sender_id,
    'source_client_id', v_source_client_id
  ));
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 definition not found';
  END IF;

  IF position('v_source_binding_metadata JSONB' IN v_def) > 0 THEN
    RAISE NOTICE 'integration_plugin_activate_core_v1 already resolves source binding metadata';
    RETURN;
  END IF;

  IF position(v_declare_from IN v_def) = 0 THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 source declaration marker not found';
  END IF;
  IF position(v_assign_from IN v_def) = 0 THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 workflow assignment marker not found';
  END IF;
  IF position(v_sender_from IN v_def) = 0 THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 source sender marker not found';
  END IF;
  IF position(v_payload_from IN v_def) = 0 THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 binding payload marker not found';
  END IF;

  v_def := replace(v_def, v_declare_from, v_declare_to);
  v_def := replace(v_def, v_assign_from, v_assign_to);
  v_def := replace(v_def, v_sender_from, v_sender_to);
  v_def := replace(v_def, v_payload_from, v_payload_to);
  v_def := replace(v_def, v_metadata_from, v_metadata_to);

  EXECUTE v_def;
END;
$patch$;

DO $provider_patch$
DECLARE
  v_def TEXT;
  v_declare_from TEXT := $from$  v_provider_id UUID := NULL;
  v_pack_id UUID := NULL;
$from$;
  v_declare_to TEXT := $to$  v_provider_id UUID := NULL;
  v_provider_base_url TEXT := NULL;
  v_pack_id UUID := NULL;
$to$;
  v_before_provider_from TEXT := $from$  IF lower(v_plugin.plugin_kind) = 'webhook' THEN
$from$;
  v_before_provider_to TEXT := $to$  v_provider_base_url := public.integration_plugin_activation_provider_base_url_v1(v_version.id);

  IF lower(v_plugin.plugin_kind) = 'webhook' THEN
$to$;
  v_metadata_from TEXT := $from$        jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id
        )
$from$;
  v_metadata_to TEXT := $to$        jsonb_strip_nulls(jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id,
          'base_url', v_provider_base_url
        ))
$to$;
  v_route_intent_from TEXT := $from$    v_route_policy := jsonb_set(v_route_policy, '{workflow,template_name}', to_jsonb(v_workflow_template_name), TRUE);
$from$;
  v_route_intent_to TEXT := $to$    v_route_policy := jsonb_set(v_route_policy, '{workflow,template_name}', to_jsonb(v_workflow_template_name), TRUE);
    IF NULLIF(btrim(COALESCE(v_version.workflow_binding->>'intent', '')), '') IS NOT NULL THEN
      v_route_policy := jsonb_set(v_route_policy, '{workflow,intent}', to_jsonb(NULLIF(btrim(v_version.workflow_binding->>'intent'), '')), TRUE);
    END IF;
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 definition not found';
  END IF;

  IF position('v_provider_base_url TEXT' IN v_def) = 0 THEN
    IF position(v_declare_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'integration_plugin_activate_core_v1 provider declaration marker not found';
    END IF;
    v_def := replace(v_def, v_declare_from, v_declare_to);
  END IF;

  IF position('integration_plugin_activation_provider_base_url_v1(v_version.id)' IN v_def) = 0 THEN
    IF position(v_before_provider_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'integration_plugin_activate_core_v1 provider base URL marker not found';
    END IF;
    v_def := replace(v_def, v_before_provider_from, v_before_provider_to);
  END IF;

  IF position($marker$'base_url', v_provider_base_url$marker$ IN v_def) = 0 THEN
    IF position(v_metadata_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'integration_plugin_activate_core_v1 provider metadata marker not found';
    END IF;
    v_def := replace(v_def, v_metadata_from, v_metadata_to);
  END IF;

  IF position($marker${workflow,intent}$marker$ IN v_def) = 0 THEN
    IF position(v_route_intent_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'integration_plugin_activate_core_v1 route intent marker not found';
    END IF;
    v_def := replace(v_def, v_route_intent_from, v_route_intent_to);
  END IF;

  EXECUTE v_def;
END;
$provider_patch$;

DO $repair$
DECLARE
  v_row RECORD;
  v_sender_id UUID;
  v_client_id UUID;
BEGIN
  FOR v_row IN
    SELECT
      pv.id AS plugin_version_id,
      b.scope_type,
      b.scope_id,
      ws.id AS source_id
    FROM public.integration_plugin_bindings b
    JOIN public.integration_plugin_versions pv
      ON pv.id = b.plugin_version_id
    JOIN public.integration_plugins p
      ON p.id = pv.plugin_id
    JOIN public.webhook_sources ws
      ON ws.id = b.runtime_resource_id
     AND b.runtime_resource_type = 'webhook_sources'
    WHERE b.binding_type = 'webhook_source'
      AND p.status = 'active'
      AND pv.status = 'active'
      AND p.active_version_id = pv.id
      AND ws.sender_id IS NULL
      AND public.integration_plugin_activation_requires_source_sender_v1(
        p.plugin_kind,
        COALESCE(pv.workflow_binding, '{}'::jsonb),
        public.integration_plugin_resolve_policy_v1('integration_plugin_policy', p.organization_id)
      )
  LOOP
    v_sender_id := public.integration_plugin_resolve_activation_sender_v1(
      v_row.plugin_version_id,
      v_row.scope_type,
      v_row.scope_id
    );

    SELECT s.client_id
      INTO v_client_id
      FROM public.senders s
     WHERE s.id = v_sender_id
     LIMIT 1;

    UPDATE public.webhook_sources ws
       SET sender_id = v_sender_id,
           managed_metadata = COALESCE(ws.managed_metadata, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'source_sender_id', v_sender_id,
               'source_client_id', v_client_id,
               'source_binding_source', 'integration_plugin_policy_repair'
             )),
           updated_at = now()
     WHERE ws.id = v_row.source_id;

    UPDATE public.integration_plugin_bindings b
       SET activation_payload = COALESCE(b.activation_payload, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'source_sender_id', v_sender_id,
               'source_client_id', v_client_id
             )),
           metadata = COALESCE(b.metadata, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'source_sender_id', v_sender_id,
               'source_client_id', v_client_id,
               'source_binding_source', 'integration_plugin_policy_repair'
             )),
           updated_at = now()
     WHERE b.runtime_resource_type = 'webhook_sources'
       AND b.runtime_resource_id = v_row.source_id;
  END LOOP;
END;
$repair$;

UPDATE public.providers p
   SET metadata = COALESCE(p.metadata, '{}'::jsonb)
     || jsonb_strip_nulls(jsonb_build_object(
       'base_url',
       public.integration_plugin_activation_provider_base_url_v1((p.metadata->>'plugin_version_id')::UUID)
     )),
       updated_at = now()
 WHERE p.metadata->>'managed_by' = 'integration_plugin'
   AND NULLIF(p.metadata->>'plugin_version_id', '') IS NOT NULL
   AND NULLIF(p.metadata->>'base_url', '') IS NULL
   AND public.integration_plugin_activation_provider_base_url_v1((p.metadata->>'plugin_version_id')::UUID) IS NOT NULL;

WITH route_binding_intents AS (
  SELECT
    ar.id AS route_id,
    COALESCE(
      NULLIF(btrim(pv.workflow_binding->>'intent'), ''),
      NULLIF(btrim(pv.workflow_binding #>> '{workflow,intent}'), ''),
      NULLIF(
        btrim(
          public.integration_plugin_resolve_policy_v1(
            'integration_plugin_policy',
            COALESCE(pv.organization_id, p.organization_id)
          ) #>> ARRAY[
            'studio_defaults',
            'source_binding',
            lower(p.plugin_kind),
            'required_for_intents',
            '0'
          ]
        ),
        ''
      )
    ) AS resolved_intent
  FROM public.api_routes ar
  JOIN public.integration_plugin_bindings b
    ON b.runtime_resource_type = 'api_routes'
   AND b.runtime_resource_id = ar.id
   AND COALESCE(b.enabled, TRUE) = TRUE
  JOIN public.integration_plugin_versions pv
    ON pv.id = b.plugin_version_id
  JOIN public.integration_plugins p
    ON p.id = pv.plugin_id
  WHERE public.integration_plugin_activation_requires_source_sender_v1(
    p.plugin_kind,
    COALESCE(pv.workflow_binding, '{}'::jsonb),
    public.integration_plugin_resolve_policy_v1(
      'integration_plugin_policy',
      COALESCE(pv.organization_id, p.organization_id)
    )
  )
)
UPDATE public.api_routes ar
   SET policy = jsonb_set(
         COALESCE(ar.policy, '{}'::jsonb),
         '{workflow,intent}',
         to_jsonb(route_binding_intents.resolved_intent),
         TRUE
       ),
       updated_at = now()
  FROM route_binding_intents
 WHERE route_binding_intents.route_id = ar.id
   AND route_binding_intents.resolved_intent IS NOT NULL
   AND COALESCE(ar.policy #>> '{workflow,intent}', '') = '';

COMMENT ON FUNCTION public.integration_plugin_activate_core_v1(UUID, TEXT, UUID, TEXT)
  IS 'Activates approved integration plugin versions, materializes runtime source/route/provider assets, and resolves required source sender/client bindings from integration_plugin_policy for shipment-create API runtimes.';

SELECT pg_advisory_unlock(hashtext('202605222230_plugin_activation_source_binding_policy_v1'));

COMMIT;
