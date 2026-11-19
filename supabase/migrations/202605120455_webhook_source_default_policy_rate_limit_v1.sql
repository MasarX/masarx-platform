-- Console V2 webhook source creation must resolve omitted rate limits from
-- webhook_source_default_policy rows. The UI already reads this policy; the
-- write RPC must do the same instead of carrying a literal fallback.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120455_webhook_source_default_policy_rate_limit_v1'));
SET search_path TO public, extensions, pg_temp;

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
  v_default_policy JSONB := NULL;
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

  IF v_rate_limit IS NOT NULL AND v_rate_limit < 1 THEN
    RAISE EXCEPTION 'ui_upsert_webhook_source_v1 rate_limit_per_hour must be >= 1'
      USING ERRCODE = '23514';
  END IF;

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

    IF v_rate_limit IS NULL THEN
      SELECT r.value
        INTO v_default_policy
        FROM public.resolve_settings_row_from_policy_context_v1(
          'webhook_source_default_policy',
          jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_target_org,
            'sender_id', v_sender_id
          ))
        ) AS r
       LIMIT 1;

      v_rate_limit := NULLIF(v_default_policy->>'default_rate_limit_per_hour', '')::int;
      IF v_rate_limit IS NULL OR v_rate_limit < 1 THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 could not resolve webhook_source_default_policy.default_rate_limit_per_hour'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    PERFORM public.assert_webhook_source_shipment_sender_v1(v_mapping_config_id, v_sender_id);

    v_minted_token := encode(gen_random_bytes(32), 'hex');

    INSERT INTO public.webhook_sources (
      organization_id, source_identifier, name, provider_type,
      auth_token, mapping_config_id, sender_id, rate_limit_per_hour, enabled
    ) VALUES (
      v_target_org, v_source_identifier, v_name, v_provider_type,
      v_minted_token, v_mapping_config_id, v_sender_id, v_rate_limit, v_enabled
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
  IS 'Canonical Console V2 write RPC for webhook_sources, sender/client binding, plugin policy repair, token minting, row-driven default rate-limit resolution, and optional HMAC policy binding. Capability: webhooks.write.';

SELECT pg_advisory_unlock(hashtext('202605120455_webhook_source_default_policy_rate_limit_v1'));
COMMIT;
