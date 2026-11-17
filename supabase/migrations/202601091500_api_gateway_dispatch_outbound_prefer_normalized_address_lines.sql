-- Plan: PLAN-202601-workflow-logestechs-address-sync / Step: S02
-- Migration: API gateway dispatch should prefer normalized address lines
-- Date: 2026-01-09

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_api_gateway_dispatch_outbound_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
SECURITY DEFINER
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_api JSONB := COALESCE(v_ctx->'api_gateway', '{}'::jsonb);
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);

  v_corr UUID;

  v_request_id UUID := NULLIF(v_api->>'api_gateway_request_id', '')::uuid;
  v_route_id UUID := NULLIF(v_api->>'route_id', '')::uuid;
  v_provider_id UUID := NULLIF(v_api->>'provider_id', '')::uuid;
  v_org UUID := NULLIF(v_ctx->>'organization_id', '')::uuid;
  v_client UUID := NULLIF(v_ctx->>'client_id', '')::uuid;
  v_sender UUID := NULLIF(v_ctx->>'sender_id', '')::uuid;
  v_source UUID := NULLIF(v_ctx->>'source_id', '')::uuid;

  v_request_body JSONB := COALESCE(v_api->'request_body', '{}'::jsonb);
  v_headers JSONB := COALESCE(v_api->'outbound_headers', '{}'::jsonb);
  v_method TEXT := upper(COALESCE(NULLIF(v_api->>'upstream_method', ''), 'POST'));
  v_url TEXT := COALESCE(NULLIF(v_api->>'upstream_url', ''), '');
  v_priority INT := COALESCE(NULLIF(v_api->>'priority', '')::int, 100);
  v_max_retries INT := COALESCE(NULLIF(v_api->>'max_retries', '')::int, 3);
  v_auth JSONB := COALESCE(v_api->'auth', '{}'::jsonb);
  v_provider_account_category TEXT := NULLIF(v_api->>'provider_account_category', '');
  v_provider_account_settings_resolution_id UUID := NULLIF(v_api->>'provider_account_settings_resolution_id', '')::uuid;

  v_address_id UUID := NULLIF(v_ctx->>'address_id', '')::uuid;
  v_address_resolution JSONB;
  v_address_effective JSONB;
  v_effective_line1 TEXT;
  v_effective_line2 TEXT;

  v_path_line1 TEXT[];
  v_path_line2 TEXT[];
  v_body JSONB;
  v_outbound_id UUID;

  v_response public.workflow_handler_response;
BEGIN
  BEGIN
    v_corr := NULLIF(v_ctx->>'correlation_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_corr := NULL;
  END;
  v_corr := COALESCE(v_corr, public.current_correlation_id(), gen_random_uuid());

  IF v_org IS NULL OR v_request_id IS NULL OR v_route_id IS NULL OR v_provider_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway dispatch: missing required context (organization_id/api_gateway_request_id/route_id/provider_id)';
  END IF;

  IF v_url IS NULL OR btrim(v_url) = '' THEN
    RAISE EXCEPTION 'api_gateway dispatch: upstream_url missing in run.context.api_gateway';
  END IF;

  -- Optional: override two address-line fields from SSOT effective destination address.
  BEGIN
    v_path_line1 := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_metadata->'address_line_overrides'->'line1_path', '[]'::jsonb))
    );
  EXCEPTION
    WHEN others THEN
      v_path_line1 := NULL;
  END;

  BEGIN
    v_path_line2 := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_metadata->'address_line_overrides'->'line2_path', '[]'::jsonb))
    );
  EXCEPTION
    WHEN others THEN
      v_path_line2 := NULL;
  END;

  v_body := COALESCE(v_request_body, '{}'::jsonb);

  IF v_address_id IS NOT NULL AND v_path_line1 IS NOT NULL AND array_length(v_path_line1, 1) > 0 THEN
    IF v_client IS NULL THEN
      RAISE EXCEPTION 'api_gateway dispatch: client_id missing in run.context for address resolution';
    END IF;

    v_address_resolution := public.resolve_address_effective_v1(v_address_id, v_client, 'client', v_client);
    v_address_effective := COALESCE(v_address_resolution->'effective', '{}'::jsonb);

    -- Prefer normalized_line1/2 (HERE can influence these) with fallback to line1/2.
    v_effective_line1 := COALESCE(
      NULLIF(v_address_effective->>'normalized_line1', ''),
      NULLIF(v_address_effective->>'line1', '')
    );
    v_effective_line2 := COALESCE(
      NULLIF(v_address_effective->>'normalized_line2', ''),
      NULLIF(v_address_effective->>'line2', '')
    );

    IF v_effective_line1 IS NOT NULL THEN
      v_body := jsonb_set(v_body, v_path_line1, to_jsonb(v_effective_line1), TRUE);
    END IF;
    IF v_effective_line2 IS NOT NULL AND v_path_line2 IS NOT NULL AND array_length(v_path_line2, 1) > 0 THEN
      v_body := jsonb_set(v_body, v_path_line2, to_jsonb(v_effective_line2), TRUE);
    END IF;
  END IF;

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
    correlation_id,
    context,
    created_at
  ) VALUES (
    'provider_api',
    'provider',
    v_provider_id,
    v_method,
    v_url,
    COALESCE(v_headers, '{}'::jsonb),
    COALESCE(v_body, '{}'::jsonb),
    'pending_edge',
    v_priority,
    v_max_retries,
    v_now,
    v_corr,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'source_id', v_source,
      'api_gateway_request_id', v_request_id,
      'api_gateway_route_id', v_route_id,
      'api_gateway_route_name', NULLIF(v_api->>'route_name', ''),
      'api_gateway_path_params', COALESCE(v_api->'path_params', '{}'::jsonb),
      'api_gateway_materialized', COALESCE(v_api->'materialized', '{}'::jsonb),
      'provider_account_category', v_provider_account_category,
      'provider_account_settings_resolution_id', v_provider_account_settings_resolution_id,
      'auth', v_auth,
      'address_id', v_address_id,
      'address_effective', v_address_effective
    )),
    v_now
  )
  RETURNING id INTO v_outbound_id;

  UPDATE public.api_gateway_requests
  SET outbound_call_id = v_outbound_id,
      updated_at = v_now
  WHERE id = v_request_id;

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'outbound_call_id', v_outbound_id,
    'address_id', v_address_id
  ));
  v_response.context_patch := jsonb_build_object(
    'api_gateway', jsonb_build_object(
      'outbound_call_id', v_outbound_id
    )
  );

  UPDATE public.workflow_run_steps
  SET operation_result = v_response.operation_result,
      updated_at = v_now
  WHERE id = p_step.id;

  RETURN v_response;
END;
$$;

COMMIT;
