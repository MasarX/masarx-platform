-- Migration: API gateway dispatch outbound - guard against out-of-order execution (wait_workflow)
-- Purpose:
--   - Prevent provider dispatch (e.g., Logestechs create) from running before the geocoding child workflow completes.
--   - Adds a defensive gate inside the dispatch handler so even if steps run out-of-order, dispatch will return pending.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow-driven - ZERO HARD CODING.
-- Plan: PLAN-202601-workflow-logestechs-address-sync / Step: S02
-- Date: 2026-01-10

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
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);

  v_wait_step_status TEXT;
  v_wait_poll_seconds INT;
  v_wait_child_run_id UUID;
  v_wait_child_status TEXT;

  v_ctx JSONB;
  v_api JSONB;

  v_corr UUID;

  v_request_id UUID;
  v_route_id UUID;
  v_provider_id UUID;
  v_org UUID;
  v_client UUID;
  v_sender UUID;
  v_source UUID;

  v_request_body JSONB;
  v_headers JSONB;
  v_method TEXT;
  v_url TEXT;
  v_priority INT;
  v_max_retries INT;
  v_auth JSONB;
  v_provider_account_category TEXT;
  v_provider_account_settings_resolution_id UUID;

  v_address_id UUID;
  v_address_resolution JSONB;
  v_address_effective JSONB;
  v_effective_line1 TEXT;
  v_effective_line2 TEXT;
  v_effective_district TEXT;
  v_effective_city TEXT;

  v_path_line1 TEXT[];
  v_path_line2 TEXT[];
  v_path_district TEXT[];
  v_path_city TEXT[];

  v_body JSONB;
  v_outbound_id UUID;

  v_response public.workflow_handler_response;
BEGIN
  -- Defensive sequencing gate: if a prior wait_workflow step exists and is not
  -- completed, do not dispatch yet.
  SELECT
    wrs.step_status,
    GREATEST(COALESCE(NULLIF((wrs.metadata->>'poll_interval_seconds')::INT, 0), 5), 5),
    NULLIF(wrs.operation_result->>'child_workflow_run_id', '')::uuid,
    NULLIF(wrs.operation_result->>'status', '')
  INTO
    v_wait_step_status,
    v_wait_poll_seconds,
    v_wait_child_run_id,
    v_wait_child_status
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = p_step.workflow_run_id
    AND wrs.sequence_order < p_step.sequence_order
    AND wrs.handler_key = 'wait_workflow'
  ORDER BY wrs.sequence_order DESC
  LIMIT 1;

  IF FOUND AND COALESCE(v_wait_step_status, '') <> 'completed' THEN
    IF v_wait_step_status = 'failed' THEN
      v_response.status := 'failed';
      v_response.workflow_status := 'failed';
      v_response.last_error := 'blocked_by_wait_workflow_failed';
      v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'blocked_by', 'wait_workflow',
        'wait_step_status', v_wait_step_status,
        'child_workflow_run_id', v_wait_child_run_id,
        'child_workflow_status', v_wait_child_status
      ));
      RETURN v_response;
    END IF;

    v_response.status := 'pending';
    v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
    v_response.next_run_at := v_now + make_interval(secs => v_wait_poll_seconds);
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'blocked_by', 'wait_workflow',
      'wait_step_status', v_wait_step_status,
      'child_workflow_run_id', v_wait_child_run_id,
      'child_workflow_status', v_wait_child_status,
      'next_poll_seconds', v_wait_poll_seconds
    ));
    RETURN v_response;
  END IF;

  v_ctx := COALESCE(p_run.context, '{}'::jsonb);
  v_api := COALESCE(v_ctx->'api_gateway', '{}'::jsonb);

  BEGIN
    v_corr := NULLIF(v_ctx->>'correlation_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_corr := NULL;
  END;
  v_corr := COALESCE(v_corr, public.current_correlation_id(), gen_random_uuid());

  v_request_id := NULLIF(v_api->>'api_gateway_request_id', '')::uuid;
  v_route_id := NULLIF(v_api->>'route_id', '')::uuid;
  v_provider_id := NULLIF(v_api->>'provider_id', '')::uuid;
  v_org := NULLIF(v_ctx->>'organization_id', '')::uuid;
  v_client := NULLIF(v_ctx->>'client_id', '')::uuid;
  v_sender := NULLIF(v_ctx->>'sender_id', '')::uuid;
  v_source := NULLIF(v_ctx->>'source_id', '')::uuid;

  IF v_org IS NULL OR v_request_id IS NULL OR v_route_id IS NULL OR v_provider_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway dispatch: missing required context (organization_id/api_gateway_request_id/route_id/provider_id)';
  END IF;

  v_request_body := COALESCE(v_api->'request_body', '{}'::jsonb);
  v_headers := COALESCE(v_api->'outbound_headers', '{}'::jsonb);
  v_method := upper(COALESCE(NULLIF(v_api->>'upstream_method', ''), 'POST'));
  v_url := COALESCE(NULLIF(v_api->>'upstream_url', ''), '');
  v_priority := COALESCE(NULLIF(v_api->>'priority', '')::int, 100);
  v_max_retries := COALESCE(NULLIF(v_api->>'max_retries', '')::int, 3);
  v_auth := COALESCE(v_api->'auth', '{}'::jsonb);
  v_provider_account_category := NULLIF(v_api->>'provider_account_category', '');
  v_provider_account_settings_resolution_id := NULLIF(v_api->>'provider_account_settings_resolution_id', '')::uuid;

  IF v_url IS NULL OR btrim(v_url) = '' THEN
    RAISE EXCEPTION 'api_gateway dispatch: upstream_url missing in run.context.api_gateway';
  END IF;

  v_address_id := NULLIF(v_ctx->>'address_id', '')::uuid;

  -- Optional: override address fields from SSOT effective destination address.
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

  BEGIN
    v_path_district := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_metadata->'address_line_overrides'->'district_path', '[]'::jsonb))
    );
  EXCEPTION
    WHEN others THEN
      v_path_district := NULL;
  END;

  BEGIN
    v_path_city := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_metadata->'address_line_overrides'->'city_path', '[]'::jsonb))
    );
  EXCEPTION
    WHEN others THEN
      v_path_city := NULL;
  END;

  v_body := COALESCE(v_request_body, '{}'::jsonb);

  IF v_address_id IS NOT NULL AND v_client IS NOT NULL AND v_path_line1 IS NOT NULL AND array_length(v_path_line1, 1) > 0 THEN
    v_address_resolution := public.resolve_address_effective_v1(v_address_id, v_client, 'client', v_client);
    v_address_effective := COALESCE(v_address_resolution->'effective', '{}'::jsonb);

    v_effective_line1 := COALESCE(
      NULLIF(v_address_effective->>'normalized_line1', ''),
      NULLIF(v_address_effective->>'line1', '')
    );
    v_effective_line2 := COALESCE(
      NULLIF(v_address_effective->>'normalized_line2', ''),
      NULLIF(v_address_effective->>'line2', '')
    );
    v_effective_district := NULLIF(v_address_effective->>'district', '');
    v_effective_city := NULLIF(v_address_effective->>'city', '');

    IF v_effective_line1 IS NOT NULL THEN
      v_body := jsonb_set(v_body, v_path_line1, to_jsonb(v_effective_line1), TRUE);
    END IF;

    IF v_effective_line2 IS NOT NULL AND v_path_line2 IS NOT NULL AND array_length(v_path_line2, 1) > 0 THEN
      v_body := jsonb_set(v_body, v_path_line2, to_jsonb(v_effective_line2), TRUE);
    END IF;

    IF v_effective_district IS NOT NULL AND v_path_district IS NOT NULL AND array_length(v_path_district, 1) > 0 THEN
      v_body := jsonb_set(v_body, v_path_district, to_jsonb(v_effective_district), TRUE);
    END IF;

    IF v_effective_city IS NOT NULL AND v_path_city IS NOT NULL AND array_length(v_path_city, 1) > 0 THEN
      v_body := jsonb_set(v_body, v_path_city, to_jsonb(v_effective_city), TRUE);
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

-- Ensure the Logestechs v2 geocode-first template dispatch step can override
-- district/city in addition to line1/line2 (still fully metadata-driven).
UPDATE public.workflow_template_steps
SET metadata = jsonb_set(
    jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{address_line_overrides,district_path}',
      ' ["destinationAddress","district"] '::jsonb,
      TRUE
    ),
    '{address_line_overrides,city_path}',
    ' ["destinationAddress","city"] '::jsonb,
    TRUE
  ),
  updated_at = now()
WHERE workflow_template_id = '99990000-0000-0000-0000-000000790001'::uuid
  AND operation_name = 'dispatch_create';

COMMIT;
