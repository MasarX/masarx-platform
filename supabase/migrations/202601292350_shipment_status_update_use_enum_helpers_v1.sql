-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Shipment status update handler uses enum helpers v1
-- Purpose:
--   - Use shared enum normalization + field mapping resolver helpers (SSOT).
--   - Validate mapped canonical status against lookup taxonomy (shipment_status).
--   - Remove duplicated normalization logic while preserving existing behavior.
-- Date: 2026-01-29

BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_status_update_v1(
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
  v_response public.workflow_handler_response;
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_system TEXT := 'workflow_status_update';

  v_webhook_id UUID;
  v_webhook RECORD;
  v_source RECORD;

  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
  v_source_id UUID;
  v_provider_name TEXT;
  v_correlation_id UUID;

  v_transformed JSONB;
  v_shipment JSONB;
  v_tracking TEXT;
  v_provider_status_raw TEXT;
  v_provider_status_norm TEXT;
  v_canonical_status TEXT;
  v_status_mapping_id UUID;
  v_time_raw TEXT;
  v_occurred_at TIMESTAMPTZ;

  v_shipment_id UUID;
  v_previous_status TEXT;
  v_action_data JSONB;

  v_policy_row RECORD;
  v_policy JSONB;
  v_filter_mode TEXT;
  v_filter_statuses JSONB;
  v_filter_has BOOLEAN := FALSE;
  v_forward_allowed BOOLEAN := FALSE;
  v_forward_reason TEXT;
  v_settings_resolution_id UUID;

  v_payload JSONB;
  v_payload_mode TEXT;
  v_payload_mapping_id UUID;
  v_headers JSONB;
  v_method TEXT;
  v_url TEXT;
  v_auth JSONB;
  v_outbound_id UUID;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  BEGIN
    v_webhook_id := NULLIF(v_ctx->>'webhook_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_id := NULL;
  END;

  IF v_webhook_id IS NULL THEN
    v_response.status := 'failed';
    v_response.last_error := 'missing_webhook_id';
    v_response.operation_result := jsonb_build_object('error', 'missing_webhook_id');
    RETURN v_response;
  END IF;

  SELECT wi.*
    INTO v_webhook
    FROM public.webhook_inbox wi
   WHERE wi.id = v_webhook_id;

  IF NOT FOUND THEN
    v_response.status := 'failed';
    v_response.last_error := 'webhook_not_found';
    v_response.operation_result := jsonb_build_object('error', 'webhook_not_found', 'webhook_id', v_webhook_id);
    RETURN v_response;
  END IF;

  SELECT ws.id,
         ws.organization_id,
         ws.provider_type,
         ws.sender_id,
         ws.mapping_config_id,
         s.client_id,
         ws.source_identifier
    INTO v_source
    FROM public.webhook_sources ws
    LEFT JOIN public.senders s ON s.id = ws.sender_id
   WHERE ws.id = v_webhook.webhook_source_id;

  IF NOT FOUND THEN
    v_response.status := 'failed';
    v_response.last_error := 'webhook_source_not_found';
    v_response.operation_result := jsonb_build_object('error', 'webhook_source_not_found', 'webhook_source_id', v_webhook.webhook_source_id);
    RETURN v_response;
  END IF;

  v_org_id := COALESCE(NULLIF(v_ctx->>'organization_id', '')::UUID, v_source.organization_id);
  v_client_id := COALESCE(NULLIF(v_ctx->>'client_id', '')::UUID, v_source.client_id);
  v_sender_id := COALESCE(NULLIF(v_ctx->>'sender_id', '')::UUID, v_source.sender_id);
  v_source_id := v_source.id;
  v_correlation_id := COALESCE(NULLIF(v_ctx->>'correlation_id', '')::UUID, v_webhook.correlation_id);
  v_provider_name := COALESCE(NULLIF(v_source.provider_type, ''), 'logestechs_3pl');

  IF v_org_id IS NULL OR v_client_id IS NULL THEN
    v_response.status := 'failed';
    v_response.last_error := 'missing_scope';
    v_response.operation_result := jsonb_build_object('error', 'missing_org_or_client', 'webhook_id', v_webhook_id);
    RETURN v_response;
  END IF;

  v_transformed := v_webhook.transformed_payload;
  IF v_transformed IS NULL
     OR v_transformed = '{}'::jsonb
     OR jsonb_typeof(v_transformed->'shipment') <> 'object'
     OR v_transformed->'shipment' = '{}'::jsonb THEN
    v_transformed := public.apply_mapping_config(v_webhook.raw_payload, v_source.mapping_config_id);
    UPDATE public.webhook_inbox
       SET transformed_payload = COALESCE(v_transformed, '{}'::jsonb)
     WHERE id = v_webhook_id;
  END IF;

  v_transformed := COALESCE(v_transformed, '{}'::jsonb);
  v_shipment := COALESCE(v_transformed->'shipment', '{}'::jsonb);

  v_tracking := NULLIF(v_shipment->>'tracking_number', '');
  IF v_tracking IS NULL THEN
    v_tracking := NULLIF(v_shipment->>'barcode', '');
  END IF;
  IF v_tracking IS NULL THEN
    v_tracking := NULLIF(v_transformed->>'barcode', '');
  END IF;
  IF v_tracking IS NULL THEN
    v_tracking := NULLIF(v_webhook.raw_payload->>'barcode', '');
  END IF;

  IF v_tracking IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'webhook_processing',
      p_resource_type := 'webhook_inbox',
      p_resource_id := v_webhook_id,
      p_decision_point := 'shipment_lookup',
      p_decision_outcome := 'missing_tracking',
      p_performed_by_system := v_system,
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object('webhook_id', v_webhook_id)
    );
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('status', 'skipped_missing_tracking', 'webhook_id', v_webhook_id);
    RETURN v_response;
  END IF;

  v_provider_status_raw := NULLIF(v_shipment->>'provider_status', '');
  IF v_provider_status_raw IS NULL THEN
    v_provider_status_raw := NULLIF(v_transformed->>'newStatus', '');
  END IF;
  IF v_provider_status_raw IS NULL THEN
    v_provider_status_raw := NULLIF(v_webhook.raw_payload->>'newStatus', '');
  END IF;

  IF v_provider_status_raw IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'webhook_processing',
      p_resource_type := 'webhook_inbox',
      p_resource_id := v_webhook_id,
      p_decision_point := 'status_mapping',
      p_decision_outcome := 'missing_status',
      p_performed_by_system := v_system,
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object('tracking_number', v_tracking)
    );
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('status', 'skipped_missing_status', 'tracking_number', v_tracking);
    RETURN v_response;
  END IF;

  SELECT provider_value_normalized, canonical_value, mapping_id
    INTO v_provider_status_norm, v_canonical_status, v_status_mapping_id
    FROM public.resolve_field_mapping_enum_v1(
      'shipment_status',
      v_provider_name,
      'inbound',
      v_provider_status_raw
    );

  IF v_provider_status_norm IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'transformation',
      p_resource_type := 'webhook_inbox',
      p_resource_id := v_webhook_id,
      p_decision_point := 'status_mapping',
      p_decision_outcome := 'invalid_status',
      p_performed_by_system := v_system,
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object('provider_status', v_provider_status_raw)
    );
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('status', 'skipped_invalid_status', 'provider_status', v_provider_status_raw);
    RETURN v_response;
  END IF;

  IF v_canonical_status IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'transformation',
      p_resource_type := 'webhook_inbox',
      p_resource_id := v_webhook_id,
      p_decision_point := 'status_mapping',
      p_decision_outcome := 'unmapped_status',
      p_performed_by_system := v_system,
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object(
        'provider_status', v_provider_status_raw,
        'provider_status_normalized', v_provider_status_norm,
        'provider_name', v_provider_name
      )
    );
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'status', 'skipped_unmapped_status',
      'provider_status', v_provider_status_raw,
      'provider_status_normalized', v_provider_status_norm
    );
    RETURN v_response;
  END IF;

  IF NOT public.is_active_lookup_value_v1('shipment_status', v_canonical_status, TRUE) THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'transformation',
      p_resource_type := 'webhook_inbox',
      p_resource_id := v_webhook_id,
      p_decision_point := 'status_mapping',
      p_decision_outcome := 'invalid_canonical_status',
      p_performed_by_system := v_system,
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object(
        'provider_status', v_provider_status_raw,
        'provider_status_normalized', v_provider_status_norm,
        'provider_name', v_provider_name,
        'canonical_status', v_canonical_status,
        'status_mapping_id', v_status_mapping_id
      )
    );
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'status', 'skipped_invalid_canonical_status',
      'provider_status', v_provider_status_raw,
      'provider_status_normalized', v_provider_status_norm,
      'canonical_status', v_canonical_status
    );
    RETURN v_response;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'transformation',
    p_resource_type := 'webhook_inbox',
    p_resource_id := v_webhook_id,
    p_decision_point := 'status_mapping',
    p_decision_outcome := 'mapped',
    p_performed_by_system := v_system,
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object(
      'provider_status', v_provider_status_raw,
      'provider_status_normalized', v_provider_status_norm,
      'canonical_status', v_canonical_status,
      'provider_name', v_provider_name,
      'status_mapping_id', v_status_mapping_id
    )
  );

  SELECT id, status
    INTO v_shipment_id, v_previous_status
    FROM public.shipments
   WHERE client_id = v_client_id
     AND tracking_upper = upper(v_tracking)
   LIMIT 1;

  IF v_shipment_id IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'webhook_processing',
      p_resource_type := 'webhook_inbox',
      p_resource_id := v_webhook_id,
      p_decision_point := 'shipment_lookup',
      p_decision_outcome := 'shipment_not_found',
      p_performed_by_system := v_system,
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object(
        'tracking_number', v_tracking,
        'client_id', v_client_id
      )
    );
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('status', 'skipped_shipment_missing', 'tracking_number', v_tracking);
    RETURN v_response;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = v_shipment_id
       AND sa.action_data->>'webhook_id' = v_webhook_id::text
     LIMIT 1
  ) THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'webhook_processing',
      p_resource_type := 'shipment',
      p_resource_id := v_shipment_id,
      p_decision_point := 'status_update',
      p_decision_outcome := 'duplicate_webhook',
      p_performed_by_system := v_system,
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object('webhook_id', v_webhook_id)
    );
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('status', 'duplicate_webhook', 'shipment_id', v_shipment_id);
    RETURN v_response;
  END IF;

  v_time_raw := NULLIF(v_shipment->>'occurred_at', '');
  IF v_time_raw IS NULL THEN
    v_time_raw := NULLIF(v_shipment->>'time', '');
  END IF;
  IF v_time_raw IS NULL THEN
    v_time_raw := NULLIF(v_transformed->>'time', '');
  END IF;
  IF v_time_raw IS NULL THEN
    v_time_raw := NULLIF(v_webhook.raw_payload->>'time', '');
  END IF;

  IF v_time_raw IS NOT NULL THEN
    BEGIN
      v_occurred_at := to_timestamp((v_time_raw::numeric) / 1000.0);
    EXCEPTION
      WHEN others THEN
        BEGIN
          v_occurred_at := v_time_raw::timestamptz;
        EXCEPTION
          WHEN others THEN
            v_occurred_at := NULL;
        END;
    END;
  END IF;

  UPDATE public.shipments
     SET status = v_canonical_status,
         status_updated_at = COALESCE(v_occurred_at, now()),
         updated_at = now()
   WHERE id = v_shipment_id
     AND client_id = v_client_id;

  v_action_data := jsonb_strip_nulls(jsonb_build_object(
    'webhook_id', v_webhook_id,
    'webhook_source_id', v_source_id,
    'source_identifier', v_source.source_identifier,
    'provider_status', v_provider_status_raw,
    'provider_status_normalized', v_provider_status_norm,
    'status_mapping_id', v_status_mapping_id,
    'tracking_number', v_tracking,
    'barcode', v_shipment->>'barcode',
    'bundle_id', v_shipment->>'bundle_id',
    'invoice_number', v_shipment->>'invoice_number',
    'cod', v_shipment->'cod',
    'payment_type', v_shipment->>'payment_type',
    'driver_name', v_shipment->>'driver_name',
    'driver_phone', v_shipment->>'driver_phone',
    'attachment_urls', v_shipment->'attachment_urls',
    'webhook_url', v_shipment->>'webhook_url',
    'package_id', v_shipment->>'package_id'
  ));

  INSERT INTO public.shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_system,
    action_data,
    timestamp
  ) VALUES (
    v_shipment_id,
    v_org_id,
    v_client_id,
    'status_change',
    'operational',
    v_canonical_status,
    v_system,
    v_action_data,
    COALESCE(v_occurred_at, now())
  );

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'webhook_processing',
    p_resource_type := 'shipment',
    p_resource_id := v_shipment_id,
    p_decision_point := 'status_update',
    p_decision_outcome := 'updated',
    p_performed_by_system := v_system,
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_previous_status,
      'canonical_status', v_canonical_status,
      'provider_status', v_provider_status_norm,
      'status_mapping_id', v_status_mapping_id
    ))
  );

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_context(
      'client_webhook_policy',
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'webhook_source_id', v_source_id
      ))
    )
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);

  IF v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'client_webhook_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := COALESCE(v_policy_row.version, 1),
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'webhook_id', v_webhook_id,
        'shipment_id', v_shipment_id,
        'canonical_status', v_canonical_status,
        'provider_status', v_provider_status_norm,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'webhook_source_id', v_source_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_forward_allowed := COALESCE(NULLIF(v_policy->>'enabled', '')::BOOLEAN, FALSE);
  v_url := NULLIF(v_policy->>'url', '');
  IF v_forward_allowed AND v_url IS NULL THEN
    v_forward_allowed := FALSE;
    v_forward_reason := 'missing_url';
  END IF;

  v_filter_mode := COALESCE(NULLIF(v_policy#>>'{filter,mode}', ''), 'all');
  v_filter_statuses := COALESCE(v_policy#>'{filter,statuses}', '[]'::jsonb);

  IF v_forward_allowed THEN
    IF v_filter_mode = 'none' THEN
      v_forward_allowed := FALSE;
      v_forward_reason := 'filter_none';
    ELSIF v_filter_mode = 'allowlist' THEN
      SELECT EXISTS(
        SELECT 1
          FROM jsonb_array_elements_text(v_filter_statuses) AS s(val)
         WHERE lower(s.val) = lower(v_canonical_status)
      ) INTO v_filter_has;
      v_forward_allowed := v_filter_has;
      IF NOT v_filter_has THEN
        v_forward_reason := 'filter_allowlist_miss';
      END IF;
    ELSIF v_filter_mode = 'blocklist' THEN
      SELECT EXISTS(
        SELECT 1
          FROM jsonb_array_elements_text(v_filter_statuses) AS s(val)
         WHERE lower(s.val) = lower(v_canonical_status)
      ) INTO v_filter_has;
      v_forward_allowed := NOT v_filter_has;
      IF v_filter_has THEN
        v_forward_reason := 'filter_blocked';
      END IF;
    ELSIF v_filter_mode <> 'all' THEN
      v_forward_allowed := FALSE;
      v_forward_reason := 'filter_unknown';
    END IF;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'webhook_routing',
    p_resource_type := 'webhook_inbox',
    p_resource_id := v_webhook_id,
    p_decision_point := 'client_webhook_filter',
    p_decision_outcome := CASE WHEN v_forward_allowed THEN 'forward' ELSE 'skip' END,
    p_performed_by_system := v_system,
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'canonical_status', v_canonical_status,
      'filter_mode', v_filter_mode,
      'filter_statuses', v_filter_statuses,
      'policy_enabled', COALESCE(NULLIF(v_policy->>'enabled', '')::BOOLEAN, FALSE),
      'url', v_url
    )),
    p_decision_reason := v_forward_reason,
    p_settings_resolution_id := v_settings_resolution_id
  );

  IF v_forward_allowed THEN
    v_payload_mapping_id := NULLIF(v_policy#>>'{payload,mapping_config_id}', '')::UUID;
    IF v_payload_mapping_id IS NOT NULL THEN
      v_payload := public.apply_mapping_config(v_webhook.raw_payload, v_payload_mapping_id);
    ELSE
      v_payload_mode := COALESCE(NULLIF(v_policy#>>'{payload,mode}', ''), 'passthrough_raw');
      IF v_payload_mode = 'passthrough_transformed' THEN
        v_payload := v_transformed;
      ELSE
        v_payload := v_webhook.raw_payload;
      END IF;
    END IF;

    v_headers := COALESCE(v_policy->'headers', '{}'::jsonb);
    IF jsonb_typeof(v_headers) <> 'object' THEN
      v_headers := '{}'::jsonb;
    END IF;
    IF NOT (v_headers ? 'content-type') THEN
      v_headers := v_headers || jsonb_build_object('content-type', 'application/json');
    END IF;

    v_method := upper(COALESCE(NULLIF(v_policy->>'method', ''), 'POST'));
    v_auth := v_policy->'auth';
    IF jsonb_typeof(v_auth) <> 'object' THEN
      v_auth := NULL;
    END IF;

    INSERT INTO public.outbound_calls (
      call_type,
      target_type,
      target_id,
      method,
      url,
      headers,
      body,
      correlation_id,
      shipment_id,
      context,
      workflow_run_step_id
    ) VALUES (
      'client_webhook',
      'client',
      v_client_id,
      v_method,
      v_url,
      v_headers,
      COALESCE(v_payload, '{}'::jsonb),
      v_correlation_id,
      v_shipment_id,
      jsonb_strip_nulls(jsonb_build_object(
        'webhook_id', v_webhook_id,
        'webhook_source_id', v_source_id,
        'client_id', v_client_id,
        'shipment_id', v_shipment_id,
        'canonical_status', v_canonical_status,
        'provider_status', v_provider_status_norm,
        'status_mapping_id', v_status_mapping_id,
        'auth', v_auth
      )),
      p_step.id
    )
    RETURNING id INTO v_outbound_id;

    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'webhook_routing',
      p_resource_type := 'outbound_call',
      p_resource_id := v_outbound_id,
      p_decision_point := 'client_webhook_enqueue',
      p_decision_outcome := 'enqueued',
      p_performed_by_system := v_system,
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_shipment_id,
        'canonical_status', v_canonical_status,
        'method', v_method,
        'url', v_url
      )),
      p_settings_resolution_id := v_settings_resolution_id
    );
  END IF;

  v_response.status := 'completed';
  v_response.workflow_status := NULL;
  v_response.next_run_at := NULL;
  v_response.last_error := NULL;
  v_response.retry_attempt := COALESCE(p_step.retry_attempt, 1);
  v_response.max_retries := COALESCE(p_step.max_retries, 3);
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_shipment_id,
    'tracking_number', v_tracking,
    'canonical_status', v_canonical_status,
    'provider_status', v_provider_status_raw,
    'forwarded', v_forward_allowed,
    'outbound_call_id', v_outbound_id
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'shipment', jsonb_build_object(
      'id', v_shipment_id,
      'tracking_number', v_tracking,
      'status', v_canonical_status
    ),
    'client_webhook', jsonb_build_object(
      'forwarded', v_forward_allowed,
      'outbound_call_id', v_outbound_id
    )
  ));

  RETURN v_response;
EXCEPTION
  WHEN others THEN
    v_response.status := 'failed';
    v_response.last_error := SQLERRM;
    v_response.operation_result := jsonb_build_object('error', SQLERRM);
    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_status_update_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
)
IS 'Map provider shipment status to canonical status, update shipment, and conditionally forward webhook to client based on policy.';

COMMIT;

