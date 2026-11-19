-- Console V2 webhook HMAC policy wiring and Vault-backed validation.
--
-- Source HMAC is part of the first-tenant webhook intake lifecycle. Operators
-- configure it through webhook source upsert; the receiver validates against
-- provider_auth_configs through the canonical Vault-aware credential resolver.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605110620_console_v2_webhook_hmac_policy_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.apply_webhook_source_hmac_policy_v1(
  p_webhook_source_id UUID,
  p_enabled BOOLEAN,
  p_auth_config_id UUID DEFAULT NULL,
  p_header TEXT DEFAULT NULL,
  p_algorithm TEXT DEFAULT NULL,
  p_signature_encoding TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_org UUID := public.current_user_org_id();
  v_source public.webhook_sources%ROWTYPE;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_validation JSONB := '{}'::jsonb;
  v_auth_provider_org UUID;
  v_auth_type TEXT;
  v_credentials JSONB;
  v_secret TEXT;
  v_header TEXT := lower(NULLIF(btrim(COALESCE(p_header, '')), ''));
  v_algorithm TEXT := upper(NULLIF(btrim(COALESCE(p_algorithm, '')), ''));
  v_signature_encoding TEXT := lower(NULLIF(btrim(COALESCE(p_signature_encoding, '')), ''));
BEGIN
  IF p_webhook_source_id IS NULL THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 requires webhook_source_id'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  SELECT *
    INTO v_source
    FROM public.webhook_sources
   WHERE id = p_webhook_source_id
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 webhook_source % not found', p_webhook_source_id
      USING ERRCODE = '23503';
  END IF;

  IF v_user_org IS NOT NULL
     AND v_source.organization_id <> v_user_org
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 webhook_source % outside tenant scope', p_webhook_source_id
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := p_webhook_source_id)
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.policy, '{}'::jsonb);
  v_validation := COALESCE(v_policy->'validation', '{}'::jsonb);

  IF COALESCE(p_enabled, FALSE) IS DISTINCT FROM TRUE THEN
    v_validation := v_validation - 'hmac';
    v_policy := jsonb_set(v_policy, '{validation}', v_validation, TRUE);
    PERFORM public.upsert_webhook_ingest_policy('source', p_webhook_source_id, v_policy);
    RETURN jsonb_build_object(
      'ok', TRUE,
      'webhook_source_id', p_webhook_source_id,
      'hmac_enabled', FALSE
    );
  END IF;

  IF p_auth_config_id IS NULL THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 requires hmac auth_config_id when enabled'
      USING ERRCODE = '23502';
  END IF;

  SELECT p.organization_id, pac.auth_type
    INTO v_auth_provider_org, v_auth_type
    FROM public.provider_auth_configs pac
    JOIN public.providers p ON p.id = pac.provider_id
   WHERE pac.id = p_auth_config_id
   LIMIT 1;

  IF v_auth_provider_org IS NULL THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 auth_config % not found', p_auth_config_id
      USING ERRCODE = '23503';
  END IF;

  IF v_auth_provider_org <> v_source.organization_id
     AND v_auth_provider_org <> '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 auth_config % outside source organization', p_auth_config_id
      USING ERRCODE = '42501';
  END IF;

  IF lower(COALESCE(v_auth_type, '')) <> 'hmac' THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 auth_config % must use auth_type=hmac', p_auth_config_id
      USING ERRCODE = '23514';
  END IF;

  v_credentials := public.get_provider_auth_credentials(p_auth_config_id);
  v_secret := COALESCE(
    v_credentials->>'signing_secret',
    v_credentials->>'secret',
    v_credentials->>'api_key'
  );

  IF v_secret IS NULL OR btrim(v_secret) = '' THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 auth_config % has no signing secret', p_auth_config_id
      USING ERRCODE = '23502';
  END IF;

  IF v_header IS NULL THEN
    v_header := 'x-signature';
  END IF;
  IF v_header !~ '^[a-z0-9][a-z0-9-]*$' THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 invalid HMAC header %', v_header
      USING ERRCODE = '22023';
  END IF;

  IF v_algorithm IS NULL THEN
    v_algorithm := 'HMAC-SHA256';
  END IF;
  IF v_algorithm NOT IN ('HMAC-SHA256', 'HMAC-SHA512') THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 unsupported algorithm %', v_algorithm
      USING ERRCODE = '22023';
  END IF;

  IF v_signature_encoding IS NULL THEN
    v_signature_encoding := 'hex';
  END IF;
  IF v_signature_encoding NOT IN ('hex', 'base64') THEN
    RAISE EXCEPTION 'apply_webhook_source_hmac_policy_v1 unsupported signature encoding %', v_signature_encoding
      USING ERRCODE = '22023';
  END IF;

  v_validation := jsonb_set(
    v_validation,
    '{hmac}',
    jsonb_build_object(
      'enabled', TRUE,
      'header', v_header,
      'algorithm', v_algorithm,
      'signature_encoding', v_signature_encoding,
      'auth_config_id', p_auth_config_id
    ),
    TRUE
  );

  v_policy := jsonb_set(v_policy, '{validation}', v_validation, TRUE);
  PERFORM public.upsert_webhook_ingest_policy('source', p_webhook_source_id, v_policy);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'webhook_source_id', p_webhook_source_id,
    'hmac_enabled', TRUE,
    'hmac_auth_config_id', p_auth_config_id,
    'hmac_header', v_header,
    'hmac_algorithm', v_algorithm,
    'hmac_signature_encoding', v_signature_encoding
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_webhook_source_hmac_policy_v1(UUID, BOOLEAN, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_webhook_source_hmac_policy_v1(UUID, BOOLEAN, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.apply_webhook_source_hmac_policy_v1(UUID, BOOLEAN, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_webhook_source_hmac_policy_v1(UUID, BOOLEAN, UUID, TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.apply_webhook_source_hmac_policy_v1(UUID, BOOLEAN, UUID, TEXT, TEXT, TEXT)
  IS 'Internal Console V2 helper: applies source-scoped webhook_ingest_policy.validation.hmac using Vault-backed provider_auth_configs without exposing secrets.';

CREATE OR REPLACE FUNCTION public.repair_integration_plugin_webhook_policy_v1(
  p_webhook_source_id UUID,
  p_plugin_version_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source public.webhook_sources%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_target TEXT;
  v_intent TEXT;
  v_template_ref TEXT;
  v_template_id UUID;
  v_policy JSONB;
  v_existing_policy JSONB := '{}'::jsonb;
  v_existing_hmac JSONB := NULL;
BEGIN
  IF p_webhook_source_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'missing_webhook_source_id');
  END IF;

  SELECT * INTO v_source
    FROM public.webhook_sources
   WHERE id = p_webhook_source_id
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'webhook_source_not_found');
  END IF;

  BEGIN
    SELECT COALESCE(policy, '{}'::jsonb)
      INTO v_existing_policy
      FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := p_webhook_source_id)
     LIMIT 1;
  EXCEPTION
    WHEN others THEN
      v_existing_policy := '{}'::jsonb;
  END;
  IF jsonb_typeof(v_existing_policy#>'{validation,hmac}') = 'object' THEN
    v_existing_hmac := v_existing_policy#>'{validation,hmac}';
  END IF;

  IF p_plugin_version_id IS NOT NULL THEN
    SELECT * INTO v_version
      FROM public.integration_plugin_versions
     WHERE id = p_plugin_version_id
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    SELECT v.* INTO v_version
      FROM public.integration_plugin_bindings b
      JOIN public.integration_plugin_versions v ON v.id = b.plugin_version_id
     WHERE b.runtime_resource_type = 'webhook_sources'
       AND b.runtime_resource_id = p_webhook_source_id
     ORDER BY b.enabled DESC, b.created_at DESC
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'plugin_version_not_found');
  END IF;

  SELECT * INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_version.plugin_id
   LIMIT 1;

  -- The default onboarding source keeps the general intake policy until an explicit shipment binding exists.
  IF v_plugin.plugin_key = 'default-shipment-webhook-intake'
     AND v_version.workflow_binding = '{"template_name":"webhook_intake_v1"}'::jsonb THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'general_onboarding_intake');
  END IF;

  v_target := lower(COALESCE(
    NULLIF(v_version.workflow_binding->>'intent', ''),
    NULLIF(v_version.mapping_config->>'target', ''),
    NULLIF(v_version.mapping_config#>>'{metadata,target}', '')
  ));

  v_intent := CASE
    WHEN v_target IN ('shipments.create', 'shipment.create') THEN 'shipment.create'
    ELSE NULL
  END;

  IF v_intent IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'skipped', TRUE,
      'reason', 'non_shipment_create_plugin',
      'plugin_key', v_plugin.plugin_key
    );
  END IF;

  v_template_ref := COALESCE(
    NULLIF(v_version.workflow_binding->>'template_id', ''),
    NULLIF(v_version.workflow_binding->>'template_name', '')
  );

  IF v_template_ref IS NULL THEN
    RAISE EXCEPTION 'repair_integration_plugin_webhook_policy_v1 requires workflow_binding.template_name/template_id for %', v_version.id;
  END IF;

  v_template_id := public.resolve_active_workflow_template_ref_v1(v_template_ref);
  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'repair_integration_plugin_webhook_policy_v1 could not resolve workflow template %', v_template_ref;
  END IF;

  v_policy := jsonb_build_object(
    'version', 1,
    'ack', jsonb_build_object(
      'mode', 'accepted_async',
      'status_code', 202,
      'default_headers', jsonb_build_object('content-type', 'application/json')
    ),
    'workflow', jsonb_build_object(
      'template_id', v_template_id,
      'intent', v_intent,
      'templates_by_intent', jsonb_build_object(
        v_intent,
        jsonb_build_object('template_id', v_template_id::text)
      ),
      'notes', format(
        'plugin_id=%s plugin_version_id=%s target=%s',
        v_plugin.id,
        v_version.id,
        v_target
      )
    ),
    'validation', jsonb_strip_nulls(jsonb_build_object(
      'idempotency', jsonb_build_object(
        'header', 'Idempotency-Key',
        'body_path', 'event.id'
      ),
      'hmac', v_existing_hmac
    ))
  );

  PERFORM public.upsert_webhook_ingest_policy('source', p_webhook_source_id, v_policy);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'webhook_source_id', p_webhook_source_id,
    'plugin_version_id', v_version.id,
    'canonical_intent', v_intent,
    'workflow_template_id', v_template_id,
    'hmac_preserved', v_existing_hmac IS NOT NULL
  );
END;
$function$;

COMMENT ON FUNCTION public.repair_integration_plugin_webhook_policy_v1(UUID, UUID)
  IS 'Repairs source-level webhook_ingest_policy from plugin binding while preserving explicit source HMAC validation settings.';

DO $patch_workflow_hmac$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb) not found';
  END IF;

  IF position('public.get_provider_auth_credentials(v_auth_config_id)' IN v_def) = 0 THEN
    v_def := replace(
      v_def,
      E'      v_secret TEXT;\n      v_computed BYTEA;',
      E'      v_secret TEXT;\n      v_credentials JSONB;\n      v_computed BYTEA;'
    );
    v_def := replace(
      v_def,
      E'        SELECT COALESCE(credentials->>''signing_secret'', credentials->>''secret'', credentials->>''api_key'')\n          INTO v_secret\n          FROM provider_auth_configs\n         WHERE id = v_auth_config_id;',
      E'        v_credentials := public.get_provider_auth_credentials(v_auth_config_id);\n        v_secret := COALESCE(\n          v_credentials->>''signing_secret'',\n          v_credentials->>''secret'',\n          v_credentials->>''api_key''\n        );'
    );

    IF position('public.get_provider_auth_credentials(v_auth_config_id)' IN v_def) = 0 THEN
      RAISE EXCEPTION 'could not patch workflow_intake_webhook_core_v1 HMAC credential resolver';
    END IF;

    EXECUTE v_def;
  END IF;
END;
$patch_workflow_hmac$;

CREATE OR REPLACE FUNCTION public.ui_upsert_webhook_source_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'source_id', '')::uuid;
  v_target_org UUID;
  v_source_identifier TEXT := NULLIF(btrim(COALESCE(p_args->>'source_identifier', '')), '');
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_provider_type TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'provider_type', '')), ''));
  v_mapping_config_id UUID := NULLIF(p_args->>'mapping_config_id', '')::uuid;
  v_sender_id_present BOOLEAN := (p_args ? 'sender_id');
  v_sender_id UUID := NULLIF(p_args->>'sender_id', '')::uuid;
  v_sender_org UUID;
  v_rate_limit INTEGER := NULLIF(p_args->>'rate_limit_per_hour', '')::int;
  v_enabled_present BOOLEAN := (p_args ? 'enabled');
  v_enabled BOOLEAN := COALESCE((p_args->>'enabled')::boolean, TRUE);
  v_hmac_present BOOLEAN := (p_args ? 'hmac_enabled')
    OR (p_args ? 'hmac_auth_config_id')
    OR (p_args ? 'hmac_header')
    OR (p_args ? 'hmac_algorithm')
    OR (p_args ? 'hmac_signature_encoding');
  v_hmac_enabled BOOLEAN := COALESCE((p_args->>'hmac_enabled')::boolean, FALSE);
  v_hmac_auth_config_id UUID := NULLIF(p_args->>'hmac_auth_config_id', '')::uuid;
  v_hmac_header TEXT := NULLIF(btrim(COALESCE(p_args->>'hmac_header', '')), '');
  v_hmac_algorithm TEXT := NULLIF(btrim(COALESCE(p_args->>'hmac_algorithm', '')), '');
  v_hmac_signature_encoding TEXT := NULLIF(btrim(COALESCE(p_args->>'hmac_signature_encoding', '')), '');
  v_before public.webhook_sources%ROWTYPE;
  v_minted_token TEXT;
  v_action TEXT;
  v_binding_repair JSONB := '{}'::jsonb;
  v_hmac_policy JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    IF v_source_identifier IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires source_identifier on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires name on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_provider_type IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires provider_type on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_mapping_config_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires mapping_config_id on create'
        USING ERRCODE = '23502';
    END IF;

    v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_org_id);
    IF v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 cannot resolve target organization'
        USING ERRCODE = '23502';
    END IF;
    IF v_org_id IS NOT NULL
       AND v_target_org <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 organization_id outside tenant scope'
        USING ERRCODE = '42501';
    END IF;

    IF v_sender_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_sender_org
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;
      IF v_sender_org IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % not found', v_sender_id
          USING ERRCODE = '23503';
      END IF;
      IF v_sender_org <> v_target_org THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % outside target organization', v_sender_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    PERFORM public.assert_webhook_source_shipment_sender_v1(v_mapping_config_id, v_sender_id);

    v_minted_token := encode(gen_random_bytes(32), 'hex');

    INSERT INTO public.webhook_sources (
      organization_id, source_identifier, name, provider_type,
      auth_token, mapping_config_id, sender_id, rate_limit_per_hour, enabled
    ) VALUES (
      v_target_org, v_source_identifier, v_name, v_provider_type,
      v_minted_token, v_mapping_config_id, v_sender_id, COALESCE(v_rate_limit, 1000), v_enabled
    )
    RETURNING id INTO v_resource_id;

    v_action := 'created';
  ELSE
    SELECT * INTO v_before FROM public.webhook_sources WHERE id = v_resource_id FOR UPDATE;
    IF v_before.id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 webhook_source % not found', v_resource_id
        USING ERRCODE = '23503';
    END IF;
    IF v_org_id IS NOT NULL
       AND v_before.organization_id <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 webhook_source % outside tenant scope', v_resource_id
        USING ERRCODE = '42501';
    END IF;

    v_target_org := v_before.organization_id;

    IF v_sender_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_sender_org
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;
      IF v_sender_org IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % not found', v_sender_id
          USING ERRCODE = '23503';
      END IF;
      IF v_sender_org <> v_target_org THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % outside target organization', v_sender_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    PERFORM public.assert_webhook_source_shipment_sender_v1(
      COALESCE(v_mapping_config_id, v_before.mapping_config_id),
      CASE WHEN v_sender_id_present THEN v_sender_id ELSE v_before.sender_id END
    );

    UPDATE public.webhook_sources
       SET source_identifier = COALESCE(v_source_identifier, source_identifier),
           name = COALESCE(v_name, name),
           provider_type = COALESCE(v_provider_type, provider_type),
           mapping_config_id = COALESCE(v_mapping_config_id, mapping_config_id),
           sender_id = CASE WHEN v_sender_id_present THEN v_sender_id ELSE sender_id END,
           rate_limit_per_hour = COALESCE(v_rate_limit, rate_limit_per_hour),
           enabled = CASE WHEN v_enabled_present THEN v_enabled ELSE enabled END,
           updated_at = now()
     WHERE id = v_resource_id;

    v_action := 'updated';
  END IF;

  v_binding_repair := public.ensure_webhook_source_plugin_binding_v1(v_resource_id);
  IF COALESCE((v_binding_repair->>'ok')::boolean, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_upsert_webhook_source_v1 could not bind source policy: %', COALESCE(v_binding_repair->>'reason', 'unknown')
      USING ERRCODE = 'P0001';
  END IF;

  IF v_hmac_present THEN
    v_hmac_policy := public.apply_webhook_source_hmac_policy_v1(
      v_resource_id,
      v_hmac_enabled,
      v_hmac_auth_config_id,
      v_hmac_header,
      v_hmac_algorithm,
      v_hmac_signature_encoding
    );
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_target_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'webhooks.upsert_source', 'webhook_source', v_resource_id,
    'ui_upsert_webhook_source_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'source_identifier', v_source_identifier,
      'name', v_name,
      'provider_type', v_provider_type,
      'mapping_config_id', v_mapping_config_id,
      'sender_id', CASE WHEN v_sender_id_present THEN to_jsonb(v_sender_id) ELSE NULL END,
      'rate_limit_per_hour', v_rate_limit,
      'enabled', CASE WHEN v_enabled_present THEN to_jsonb(v_enabled) ELSE NULL END,
      'hmac_enabled', CASE WHEN v_hmac_present THEN to_jsonb(v_hmac_enabled) ELSE NULL END,
      'hmac_auth_config_id', CASE WHEN v_hmac_present THEN to_jsonb(v_hmac_auth_config_id) ELSE NULL END,
      'hmac_header', CASE WHEN v_hmac_present THEN to_jsonb(v_hmac_header) ELSE NULL END,
      'hmac_algorithm', CASE WHEN v_hmac_present THEN to_jsonb(v_hmac_algorithm) ELSE NULL END,
      'hmac_signature_encoding', CASE WHEN v_hmac_present THEN to_jsonb(v_hmac_signature_encoding) ELSE NULL END
    )),
    'ui_upsert_webhook_source_v1', v_correlation_id
  );

  IF v_target_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_target_org, 'webhook_source.' || v_action, 'webhook_source', v_resource_id,
      jsonb_strip_nulls(jsonb_build_object(
        'source_identifier', v_source_identifier,
        'name', v_name,
        'provider_type', v_provider_type,
        'sender_id', CASE WHEN v_sender_id_present THEN to_jsonb(v_sender_id) ELSE NULL END,
        'hmac_enabled', CASE WHEN v_hmac_present THEN to_jsonb(v_hmac_enabled) ELSE NULL END
      )),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'webhook_source_id', v_resource_id,
    'action', v_action,
    'auth_token', v_minted_token,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'source_binding_repair', v_binding_repair,
    'hmac_policy', CASE WHEN v_hmac_present THEN v_hmac_policy ELSE NULL END
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb)
  IS 'Canonical Console V2 write RPC for webhook_sources, sender/client binding, plugin policy repair, token minting, and optional HMAC policy binding. Capability: webhooks.write.';

CREATE OR REPLACE VIEW public.v_webhook_source_directory
  WITH (security_invoker = true)
  AS
SELECT
  ws.id,
  ws.organization_id,
  ws.source_identifier,
  ws.name,
  ws.provider_type,
  ws.mapping_config_id,
  ws.rate_limit_per_hour,
  ws.enabled,
  ws.created_at,
  ws.updated_at,
  mc.mapping_key AS mapping_label,
  inbox_agg.last_event_at,
  inbox_agg.last_event_status,
  COALESCE(inbox_agg.event_count_24h, 0) AS event_count_24h,
  COALESCE(inbox_agg.error_count_24h, 0) AS error_count_24h,
  COALESCE(rule_agg.rule_count, 0) AS rule_count,
  COALESCE(rule_agg.active_rule_count, 0) AS active_rule_count,
  (ws.enabled = TRUE AND COALESCE(inbox_agg.error_count_24h, 0) = 0) AS is_healthy,
  (COALESCE(inbox_agg.error_count_24h, 0) > 0) AS has_recent_errors,
  CASE
    WHEN ws.auth_token IS NOT NULL THEN 'stored'
    WHEN ws.auth_token_hash IS NOT NULL THEN 'stored'
    ELSE NULL
  END AS auth_token_masked,
  ws.sender_id,
  snd.client_id,
  snd.name AS sender_label,
  c.name AS client_label,
  COALESCE((source_policy.cached_value#>>'{validation,hmac,enabled}')::boolean, FALSE) AS hmac_enabled,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,header}', '') AS hmac_header,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,algorithm}', '') AS hmac_algorithm,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,signature_encoding}', '') AS hmac_signature_encoding,
  NULLIF(source_policy.cached_value#>>'{validation,hmac,auth_config_id}', '')::uuid AS hmac_auth_config_id
FROM public.webhook_sources ws
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.senders snd ON snd.id = ws.sender_id
LEFT JOIN public.clients c ON c.id = snd.client_id
LEFT JOIN public.settings source_policy
  ON source_policy.category = 'webhook_ingest_policy'
 AND source_policy.scope_type = 'source'
 AND source_policy.scope_id = ws.id
LEFT JOIN LATERAL (
  SELECT
    max(wi.created_at) AS last_event_at,
    (
      SELECT wi2.processing_status
      FROM public.webhook_inbox wi2
      WHERE wi2.webhook_source_id = ws.id
      ORDER BY wi2.created_at DESC
      LIMIT 1
    ) AS last_event_status,
    count(*) FILTER (WHERE wi.created_at > (now() - INTERVAL '24 hours')) AS event_count_24h,
    count(*) FILTER (
      WHERE wi.created_at > (now() - INTERVAL '24 hours')
        AND wi.processing_status IN ('failed', 'dead_letter')
    ) AS error_count_24h
  FROM public.webhook_inbox wi
  WHERE wi.webhook_source_id = ws.id
) inbox_agg ON TRUE
LEFT JOIN LATERAL (
  SELECT
    count(*) AS rule_count,
    count(*) FILTER (WHERE wr.enabled = TRUE) AS active_rule_count
  FROM public.webhook_rules wr
  WHERE wr.webhook_source_id = ws.id
) rule_agg ON TRUE;

GRANT SELECT ON public.v_webhook_source_directory TO authenticated, service_role;

COMMENT ON VIEW public.v_webhook_source_directory
  IS 'FE-friendly webhook source projection with sender/client binding, source health, token redaction, and HMAC policy state. Mutations go through ui_upsert_webhook_source_v1 / ui_rotate_webhook_source_token_v1.';

SELECT pg_advisory_unlock(hashtext('202605110620_console_v2_webhook_hmac_policy_v1'));

COMMIT;
