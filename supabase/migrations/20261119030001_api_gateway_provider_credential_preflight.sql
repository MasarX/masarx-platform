BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

-- Keep the credential availability check in the redacted gateway path.
DO $patch$
DECLARE
  v_definition text;
  v_provider_row text := $row$      LIMIT 1;

    IF v_provider_account_settings_id IS NOT NULL THEN$row$;
  v_provider_merged text := $merged$      LIMIT 1;

    -- Merge dispatch inputs while retaining the winning row for resolution evidence.
    IF v_provider_account_settings_id IS NOT NULL THEN
      v_provider_account := COALESCE(
        NULLIF(
          public.resolve_settings_merged_from_context(
            v_provider_account_category,
            jsonb_strip_nulls(jsonb_build_object(
              'organization_id', v_org,
              'client_id', v_client,
              'sender_id', v_sender,
              'webhook_source_id', v_source.id
            ))
          ),
          '{}'::jsonb
        ),
        v_provider_account
      );$merged$;
  v_binding text := $binding$      IF v_provider_account_auth_config_id IS NOT NULL THEN
        v_auth := jsonb_set(v_auth, '{auth_config_id}', to_jsonb(v_provider_account_auth_config_id), TRUE);$binding$;
  v_checked_binding text := $checked$      IF v_provider_account_auth_config_id IS NOT NULL THEN
        v_auth := jsonb_set(v_auth, '{auth_config_id}', to_jsonb(v_provider_account_auth_config_id), TRUE);
        IF v_provider_account_require_auth_config_id
           AND public.get_provider_auth_credentials(v_provider_account_auth_config_id) IS NULL THEN
          PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'settings_resolution',
            p_resource_type := 'api_gateway_request',
            p_resource_id := v_request_id,
            p_decision_point := 'api_gateway_provider_account_credential_available',
            p_decision_outcome := 'rejected',
            p_performed_by_system := 'api_gateway',
            p_correlation_id := v_corr,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
              'provider_id', v_provider_id,
              'route_id', v_route_id,
              'route_name', v_route_row.route_name,
              'category', v_provider_account_category,
              'auth_config_id', v_provider_account_auth_config_id
            )),
            p_decision_reason := 'Provider account auth_config_id is revoked, expired, or unavailable; refusing provider dispatch.',
            p_settings_resolution_id := v_provider_account_settings_resolution_id
          );

          INSERT INTO public.outbound_calls (
            call_type,
            target_type,
            target_id,
            method,
            url,
            headers,
            body,
            status,
            priority,
            max_retries,
            scheduled_at,
            response_status_code,
            error_message,
            correlation_id,
            context,
            created_at,
            completed_at
          ) VALUES (
            'provider_api',
            'provider',
            v_provider_id,
            v_upstream_method,
            v_url_projection,
            '{}'::jsonb,
            '{}'::jsonb,
            'permanently_failed',
            COALESCE(NULLIF(v_policy->>'priority', '')::INT, 100),
            0,
            v_now,
            424,
            format('provider_auth_config_unavailable (auth_config_id=%s)', v_provider_account_auth_config_id),
            v_corr,
            jsonb_strip_nulls(jsonb_build_object(
              'organization_id', v_org,
              'client_id', v_client,
              'sender_id', v_sender,
              'source_id', v_source.id,
              'api_gateway_request_id', v_request_id,
              'api_gateway_route_id', v_route_id,
              'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1(v_policy),
              'provider_account_category', v_provider_account_category,
              'provider_account_settings_resolution_id', v_provider_account_settings_resolution_id,
              'auth', jsonb_build_object('auth_config_id', v_provider_account_auth_config_id)
            )),
            v_now,
            v_now
          )
          RETURNING id INTO v_outbound_id;

          UPDATE public.api_gateway_requests
             SET outbound_call_id = v_outbound_id,
                 updated_at = v_now
           WHERE id = v_request_id;

          RETURN jsonb_strip_nulls(jsonb_build_object(
            'action', 'error',
            'status', 424,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object(
              'error', 'provider_auth_config_unavailable',
              'api_gateway_request_id', v_request_id,
              'correlation_id', v_corr
            ),
            'api_gateway_request_id', v_request_id,
            'outbound_call_id', v_outbound_id,
            'correlation_id', v_corr
          ));
        END IF;$checked$;
BEGIN
  SELECT pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  ) INTO STRICT v_definition;

  IF length(v_definition) - length(replace(v_definition, v_provider_row, '')) <> length(v_provider_row)
     OR length(v_definition) - length(replace(v_definition, v_binding, '')) <> length(v_binding)
     OR position('api_gateway_provider_account_credential_available' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Unexpected provider credential binding in gateway intake';
  END IF;

  EXECUTE replace(replace(v_definition, v_provider_row, v_provider_merged), v_binding, v_checked_binding);
END;
$patch$;

COMMIT;
