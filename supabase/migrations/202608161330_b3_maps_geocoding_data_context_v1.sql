-- Forward-only maps/geocoding data-context readiness patch.
-- Ensures operator shipment geocode refreshes carry policy-backed Saudi short
-- national address reverse-geocode intent into the nested geocoding workflow.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606110130_maps_geocoding_data_context_readiness_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_address_id UUID := NULL;
  v_address RECORD;
  v_template_name TEXT := COALESCE(NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''), 'workflow_geocoding_standard');
  v_template_id UUID;
  v_workflow_run_id UUID;
  v_nested_context JSONB := '{}'::jsonb;
  v_nested_progress JSONB := '{}'::jsonb;
  v_nested_status TEXT := NULL;
  v_nested_last_error JSONB := NULL;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_nested_idempotency_key TEXT := NULL;
  v_manual_review_task_id UUID := NULL;
  v_geocoding_attempt_id UUID := NULL;
  v_geocode_id UUID := NULL;
  v_geocoding_policy JSONB := '{}'::jsonb;
  v_short_plugin JSONB := NULL;
  v_code_regex TEXT := '^[A-Z]{4}[0-9]{4}$';
  v_short_code TEXT := NULL;
  v_reverse_geocode BOOLEAN := FALSE;
  v_provided_coordinates JSONB := NULL;
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;

  BEGIN
    v_address_id := COALESCE(NULLIF(v_ctx->>'address_id', '')::UUID, NULLIF(v_ctx->>'destination_address_id', '')::UUID);
  EXCEPTION
    WHEN others THEN
      v_address_id := NULL;
  END;

  IF v_address_id IS NULL THEN
    v_address_id := v_target.destination_address_id;
  END IF;

  IF v_address_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'address_id_missing';
    v_result.operation_result := jsonb_build_object('error', 'address_id_missing');
    RETURN v_result;
  END IF;

  SELECT a.id, a.client_id, a.sa_short_code, a.coordinates
    INTO v_address
    FROM public.addresses a
   WHERE a.id = v_address_id
     AND (v_target.client_id IS NULL OR a.client_id = v_target.client_id)
   LIMIT 1;

  IF v_address.id IS NOT NULL THEN
    v_short_code := NULLIF(btrim(COALESCE(v_address.sa_short_code, '')), '');

    IF v_address.coordinates IS NOT NULL THEN
      v_provided_coordinates := jsonb_build_object(
        'latitude', ST_Y(v_address.coordinates::geometry),
        'longitude', ST_X(v_address.coordinates::geometry)
      );
    END IF;
  END IF;

  IF v_short_code IS NOT NULL THEN
    v_geocoding_policy := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_short_plugin := workflow_handlers.geocoding_get_plugin(COALESCE(v_geocoding_policy, '{}'::jsonb), 'short_code');
    v_code_regex := COALESCE(NULLIF(v_short_plugin->'params'->>'code_regex', ''), v_code_regex);
    v_short_code := public.geocoding_normalize_candidate_code(v_short_code, v_code_regex);
    v_reverse_geocode := lower(COALESCE(v_short_plugin->'params'->>'reverse_geocode_on_hit', 'false')) = 'true';
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'geocode_template_missing';
    v_result.operation_result := jsonb_build_object('error', 'geocode_template_missing', 'template_name', v_template_name);
    RETURN v_result;
  END IF;

  v_nested_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_ctx->>'geocode_idempotency_key', '')), ''),
    format('shipment-update-geocode:nested:%s:%s', p_run.id, v_address_id)
  );

  v_nested_context := jsonb_strip_nulls(jsonb_build_object(
    'idempotency_key', v_nested_idempotency_key,
    'organization_id', COALESCE(v_target.organization_id, NULLIF(v_ctx->>'organization_id', '')::UUID),
    'client_id', COALESCE(v_target.client_id, NULLIF(v_ctx->>'client_id', '')::UUID),
    'sender_id', COALESCE(v_target.sender_id, NULLIF(v_ctx->>'sender_id', '')::UUID),
    'shipment_id', v_target.shipment_id,
    'destination_address_id', v_address_id,
    'address_id', v_address_id,
    'actor_user_id', NULLIF(v_ctx->>'actor_user_id', ''),
    'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode'),
    'trigger_source', 'manual',
    'parent_workflow_run_id', p_run.id,
    'parent_workflow_step_id', p_step.id
  ));

  IF v_short_code IS NOT NULL THEN
    v_nested_context := jsonb_set(
      v_nested_context,
      '{geocoding}',
      jsonb_strip_nulls(jsonb_build_object(
        'short_code', v_short_code,
        'sa_short_code', v_short_code,
        'provided_coordinates', v_provided_coordinates,
        'reverse_geocode', CASE
          WHEN v_provided_coordinates IS NOT NULL THEN v_reverse_geocode
          ELSE NULL
        END
      )),
      TRUE
    );
  END IF;

  v_workflow_run_id := public.start_workflow_run(v_template_id, v_nested_context);

  v_nested_progress := public.progress_workflow_run_until_wait_v1(
    v_workflow_run_id,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_target.shipment_id,
      'client_id', v_target.client_id,
      'destination_address_id', v_address_id,
      'address_id', v_address_id,
      'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode')
    )),
    2500,
    20
  );

  SELECT wr.workflow_status, wr.last_error
    INTO v_nested_status, v_nested_last_error
    FROM public.workflow_runs wr
   WHERE wr.id = v_workflow_run_id;

  SELECT mrt.id
    INTO v_manual_review_task_id
    FROM public.manual_review_tasks mrt
   WHERE mrt.address_id = v_address_id
     AND (
       mrt.metadata->>'workflow_run_id' = v_workflow_run_id::text
       OR mrt.shipment_id = v_target.shipment_id
     )
   ORDER BY mrt.created_at DESC NULLS LAST
   LIMIT 1;

  SELECT ga.id
    INTO v_geocoding_attempt_id
    FROM public.geocoding_attempts ga
    JOIN public.workflow_run_steps wrs
      ON wrs.id = ga.workflow_run_step_id
   WHERE ga.address_id = v_address_id
     AND wrs.workflow_run_id = v_workflow_run_id
   ORDER BY ga.created_at DESC NULLS LAST
   LIMIT 1;

  SELECT g.id
    INTO v_geocode_id
    FROM public.geocodes g
   WHERE g.address_id = v_address_id
     AND g.client_id = v_target.client_id
     AND g.is_primary IS TRUE
     AND (g.expires_at IS NULL OR g.expires_at > now())
   ORDER BY g.geocoded_at DESC NULLS LAST
   LIMIT 1;

  IF v_target.shipment_id IS NOT NULL THEN
    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_target.shipment_id,
      'geocode_request',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'idempotency_key', v_event_id,
        'address_id', v_address_id,
        'workflow_run_id', v_workflow_run_id,
        'workflow_status', v_nested_status,
        'workflow_last_error', v_nested_last_error,
        'manual_review_task_id', v_manual_review_task_id,
        'geocoding_attempt_id', v_geocoding_attempt_id,
        'geocode_id', v_geocode_id,
        'nested_idempotency_key', v_nested_idempotency_key
      )),
      NULL::TEXT,
      NULL::TEXT,
      'workflow_handlers.execute_shipment_update_geocode_v1',
      NULL::UUID,
      NULL::timestamptz
    );
  END IF;

  IF lower(COALESCE(v_nested_status, '')) IN ('failed', 'cancelled', 'blocked') THEN
    v_result.status := 'failed';
    v_result.last_error := COALESCE(
      NULLIF(v_nested_progress->>'error', ''),
      NULLIF(v_nested_last_error->>'error', ''),
      'nested_geocode_workflow_' || lower(COALESCE(v_nested_status, 'failed'))
    );
  ELSE
    v_result.status := 'completed';
  END IF;

  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'address_id', v_address_id,
    'geocode_workflow_run_id', v_workflow_run_id,
    'geocode_workflow_status', v_nested_status,
    'geocode_workflow_last_error', v_nested_last_error,
    'manual_review_task_id', v_manual_review_task_id,
    'geocoding_attempt_id', v_geocoding_attempt_id,
    'geocode_id', v_geocode_id,
    'geocode_progress', v_nested_progress,
    'shipment_action_id', v_action_id
  ));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Starts a fresh nested geocoding workflow for each operator shipment geocode refresh, carries policy-backed Saudi short-address reverse-geocode intent, progresses it inline, records geocode_request lineage, propagates terminal failures, and returns same-context readback ids for manual review, attempts, and geocode rows.';

DO $do$
DECLARE
  v_short_address_paths JSONB := jsonb_build_array(
    'shipment.destination.sa_short_code',
    'shipment.destination.short_national_address',
    'shipment.destination.shortNationalAddress',
    'shipment.destination.nationalAddress',
    'destination.sa_short_code',
    'destination.short_national_address',
    'destination.shortNationalAddress',
    'destination.nationalAddress',
    'address.sa_short_code',
    'address.short_national_address',
    'address.shortNationalAddress',
    'address.nationalAddress',
    'sa_short_code',
    'short_national_address',
    'shortNationalAddress',
    'nationalAddress',
    'short_code',
    'shortCode'
  );
  v_patch JSONB;
BEGIN
  v_patch := jsonb_build_object(
    'transforms', jsonb_build_object(
      'address', jsonb_build_object(
        'sa_short_code', v_short_address_paths
      )
    ),
    'sample_input', jsonb_build_object(
      'shipment', jsonb_build_object(
        'destination', jsonb_build_object(
          'short_national_address', 'RNQA7082'
        )
      )
    ),
    'sample_output', jsonb_build_object(
      'address', jsonb_build_object(
        'sa_short_code', 'RNQA7082'
      )
    ),
    'metadata', jsonb_build_object(
      'short_address_profile', 'sa_short_national_address_v1'
    )
  );

  UPDATE public.onboarding_integration_plugin_defaults d
     SET mapping_config = public.jsonb_deep_merge(COALESCE(d.mapping_config, '{}'::jsonb), v_patch),
         updated_at = now()
   WHERE d.profile_key = 'default'
     AND d.scope_type = 'tenant'
     AND d.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(d.mapping_config, '{}'::jsonb) IS DISTINCT FROM
         public.jsonb_deep_merge(COALESCE(d.mapping_config, '{}'::jsonb), v_patch);

  UPDATE public.integration_plugin_versions v
     SET mapping_config = public.jsonb_deep_merge(COALESCE(v.mapping_config, '{}'::jsonb), v_patch),
         updated_at = now()
    FROM public.integration_plugins p
   WHERE p.id = v.plugin_id
     AND p.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(v.mapping_config, '{}'::jsonb) IS DISTINCT FROM
         public.jsonb_deep_merge(COALESCE(v.mapping_config, '{}'::jsonb), v_patch);

  UPDATE public.mapping_configs mc
     SET mapping_config = public.jsonb_deep_merge(COALESCE(mc.mapping_config, '{}'::jsonb), v_patch),
         mapping_version = COALESCE(mc.mapping_version, 1) + 1,
         updated_at = now()
   WHERE mc.mapping_type = 'webhook_inbound'
     AND (
       mc.mapping_config#>>'{metadata,mapping_profile}' = 'shipment_webhook_intake_v1'
       OR mc.mapping_config->>'label' = 'Default shipment webhook intake'
     )
     AND (
       mc.managed_by = 'integration_plugin'
       OR mc.mapping_config#>>'{metadata,managed_by}' = 'onboarding_default'
     )
     AND COALESCE(mc.mapping_config, '{}'::jsonb) IS DISTINCT FROM
         public.jsonb_deep_merge(COALESCE(mc.mapping_config, '{}'::jsonb), v_patch);
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202606110130_maps_geocoding_data_context_readiness_v1'));
COMMIT;
