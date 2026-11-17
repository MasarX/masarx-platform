-- Plan: PLAN-202601-workflow-logestechs-address-sync / Step: S01
-- Migration: Logestechs create shipment via workflow (geocode-first)
-- Date: 2026-01-09

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Handlers (row-driven via operation_handlers)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_api_gateway_materialize_addresses_v1(
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

  v_request_id UUID;
  v_request public.api_gateway_requests%ROWTYPE;
  v_route public.api_routes%ROWTYPE;
  v_policy JSONB;
  v_post JSONB;
  v_extract JSONB;
  v_request_body JSONB;

  v_origin JSONB;
  v_destination JSONB;
  v_origin_address_id UUID;
  v_destination_address_id UUID;
  v_dest_coords JSONB;

  v_response public.workflow_handler_response;
BEGIN
  v_request_id := NULLIF(v_api->>'api_gateway_request_id', '')::uuid;
  IF v_request_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway materialize: api_gateway_request_id missing in run.context.api_gateway';
  END IF;

  SELECT * INTO v_request
  FROM public.api_gateway_requests
  WHERE id = v_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'api_gateway materialize: request % not found', v_request_id;
  END IF;

  SELECT * INTO v_route
  FROM public.api_routes
  WHERE id = v_request.route_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'api_gateway materialize: route % not found', v_request.route_id;
  END IF;

  v_policy := COALESCE(v_route.policy, '{}'::jsonb);
  v_post := COALESCE(v_policy->'postprocess', '{}'::jsonb);
  v_extract := COALESCE(v_post->'extract', '{}'::jsonb);
  v_request_body := COALESCE(v_api->'request_body', v_request.request_body, '{}'::jsonb);

  v_origin := workflow_handlers.api_gateway_materialize_address_v1(v_request.organization_id, v_request.client_id, v_request_body, v_extract, 'origin');
  v_destination := workflow_handlers.api_gateway_materialize_address_v1(v_request.organization_id, v_request.client_id, v_request_body, v_extract, 'destination');

  BEGIN
    v_origin_address_id := NULLIF(v_origin->>'address_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_origin_address_id := NULL;
  END;

  BEGIN
    v_destination_address_id := NULLIF(v_destination->>'address_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_destination_address_id := NULL;
  END;

  v_dest_coords := COALESCE(v_destination->'provided_coordinates', NULL);

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'origin', v_origin,
    'destination', v_destination
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'api_gateway', jsonb_build_object(
      'materialized', jsonb_strip_nulls(jsonb_build_object(
        'origin_address_id', v_origin_address_id,
        'destination_address_id', v_destination_address_id,
        'destination_provided_coordinates', v_dest_coords
      ))
    ),
    -- Standardize keys for downstream geocoding workflow.
    'address_id', v_destination_address_id,
    'geocoding', jsonb_strip_nulls(jsonb_build_object(
      'provided_coordinates', v_dest_coords
    ))
  ));

  UPDATE public.workflow_run_steps
  SET operation_result = v_response.operation_result,
      updated_at = v_now
  WHERE id = p_step.id;

  RETURN v_response;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_api_gateway_materialize_addresses_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Workflow handler: materialize origin/destination addresses for an api_gateway_request_id (uses route policy postprocess.extract) and patches run.context with destination address_id + provided_coordinates.';


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

    v_effective_line1 := NULLIF(v_address_effective->>'line1', '');
    v_effective_line2 := NULLIF(v_address_effective->>'line2', '');

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

COMMENT ON FUNCTION workflow_handlers.execute_api_gateway_dispatch_outbound_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Workflow handler: enqueue outbound_calls using api_gateway computed upstream_url/method/headers from run.context; optionally overrides body address lines from SSOT effective address based on step.metadata.address_line_overrides.';


-- ---------------------------------------------------------------------------
-- 2) Register handlers in operation_handlers
-- ---------------------------------------------------------------------------

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES
  (
    'api_gateway_materialize_addresses',
    'workflow_handlers',
    'execute_api_gateway_materialize_addresses_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Materialize origin/destination addresses for an API gateway request (uses route policy extract paths).',
    'docs/ops/runbooks/workflow_engine_runbook.md'
  ),
  (
    'api_gateway_dispatch_outbound',
    'workflow_handlers',
    'execute_api_gateway_dispatch_outbound_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Dispatch an API gateway upstream call by inserting outbound_calls using precomputed upstream_url/method/headers; supports SSOT address-line overrides.',
    'docs/ops/runbooks/workflow_engine_runbook.md'
  )
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();


-- ---------------------------------------------------------------------------
-- 3) Workflow template + steps (declarative)
-- ---------------------------------------------------------------------------

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type,
  scope_id,
  notes
)
VALUES (
  '99990000-0000-0000-0000-000000790001',
  'api_gateway_logestechs_v2_create_geocode_first_v1',
  'API gateway Logestechs create shipment: materialize address, geocode-first, then dispatch create using SSOT effective destination address lines.',
  1,
  'active',
  'global',
  NULL,
  'Workflow-driven gate to ensure Logestechs receives post-HERE updated address lines.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

DO $do$
DECLARE
  v_template_id UUID;
  v_geocode_template_id UUID;
BEGIN
  SELECT id
  INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'api_gateway_logestechs_v2_create_geocode_first_v1'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'api_gateway_logestechs_v2_create_geocode_first_v1 not found; skipping step insert';
    RETURN;
  END IF;

  SELECT id
  INTO v_geocode_template_id
  FROM public.workflow_templates
  WHERE name = 'workflow_geocoding_standard'
    AND status = 'active'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_geocode_template_id IS NULL THEN
    RAISE EXCEPTION 'Required workflow template workflow_geocoding_standard not found (active).';
  END IF;

  DELETE FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id;

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    manual_action_required,
    enabled
  ) VALUES
    (
      '99990000-0000-0000-0000-000000790101'::uuid,
      v_template_id,
      1,
      'materialize_addresses',
      'workflow',
      'always',
      'api_gateway_materialize_addresses',
      'v1',
      '{}'::jsonb,
      FALSE,
      TRUE
    ),
    (
      '99990000-0000-0000-0000-000000790102'::uuid,
      v_template_id,
      2,
      'start_geocoding',
      'workflow',
      'always',
      'start_workflow',
      'v1',
      jsonb_build_object(
        'child_workflow_template_id', v_geocode_template_id
      ),
      FALSE,
      TRUE
    ),
    (
      '99990000-0000-0000-0000-000000790103'::uuid,
      v_template_id,
      3,
      'wait_geocoding',
      'workflow',
      'always',
      'wait_workflow',
      'v1',
      jsonb_build_object(
        'poll_interval_seconds', 5,
        'max_wait_seconds', 60
      ),
      FALSE,
      TRUE
    ),
    (
      '99990000-0000-0000-0000-000000790104'::uuid,
      v_template_id,
      4,
      'dispatch_create',
      'workflow',
      'always',
      'api_gateway_dispatch_outbound',
      'v1',
      jsonb_build_object(
        'address_line_overrides', jsonb_build_object(
          'line1_path', jsonb_build_array('destinationAddress', 'addressLine1'),
          'line2_path', jsonb_build_array('destinationAddress', 'addressLine2')
        )
      ),
      FALSE,
      TRUE
    );
END;
$do$;

COMMIT;
