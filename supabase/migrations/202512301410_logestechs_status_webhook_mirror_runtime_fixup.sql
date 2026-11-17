-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Logestechs status webhook mirror runtime fixup
-- Purpose: Ensure mapping_config + field_mappings + status-update handler + workflow step exist (idempotent).
-- Date: 2025-12-30

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- 3) Mapping config for Logestechs status webhooks
-- ---------------------------------------------------------------------------
INSERT INTO public.mapping_configs (
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  'webhook_inbound',
  'logestechs_status_update_v1',
  jsonb_build_object(
    'description', 'Logestechs status webhook mapping (canonical shipment fields)',
    'external_id_path', 'time',
    'event_type_path', 'newStatus',
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'tracking_number', jsonb_build_array('barcode', 'packageId'),
        'provider_status', jsonb_build_array('newStatus', 'status'),
        'occurred_at', jsonb_build_array('time'),
        'barcode', 'barcode',
        'bundle_id', 'bundleId',
        'invoice_number', 'invoiceNumber',
        'cod', 'cod',
        'payment_type', 'paymentType',
        'driver_name', 'driverName',
        'driver_phone', 'driverPhone',
        'attachment_urls', 'attachmentUrls',
        'webhook_url', 'webhookUrl',
        'package_id', 'packageId'
      )
    )
  ),
  1,
  'Logestechs status webhook mapping (barcode + status + timestamps).'
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    mapping_version = EXCLUDED.mapping_version,
    notes = EXCLUDED.notes,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 4) Field mappings: Logestechs provider status -> MasarX canonical status
-- ---------------------------------------------------------------------------
INSERT INTO public.field_mappings (
  mapping_domain,
  provider_name,
  direction,
  provider_value,
  canonical_value
)
VALUES
  ('shipment_status', 'logestechs_3pl', 'inbound', 'ACCEPTED_BY_DRIVER_AND_PENDING_PICKUP', 'pending'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'ASSIGNED_TO_DRIVER_AND_PENDING_APPROVAL', 'pending'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'CREATED', 'pending'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'DRAFT', 'pending'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'INVOICED', 'pending'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'FULFILLMENT_PENDING_ORDER', 'pending'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'PENDING_CUSTOMER_CARE_APPROVAL', 'pending'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'DELAYED_PROCESSING_ORDER', 'pending'),

  ('shipment_status', 'logestechs_3pl', 'inbound', 'ARRIVED', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'BROUGHT', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'IN_HUB', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'IN_TRANSIT', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'RECEIVED_AT_DEPARTURE_STATION', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'RECEIVED_IN_HUB', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'TRANSFERRED_OUT', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'WITH_PARTNER', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'EXPORTED', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'EXPORTED_TO_HUB', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'EXPORTED_TO_THIRD_PARTY', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'CONTAINER_UNLOADED_AND_CLEARED_OUT', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'MOVED_TO_SHELF_AND_OUT_OF_HANDLER_CUSTODY', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'SCANNED_BY_HANDLER_AND_UNLOADED', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'DELAYED', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'POSTPONED_DELIVERY', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'RESOLVED_FAILURE', 'in_transit'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'OUT_FOR_DELIVERY', 'out_for_delivery'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'IN_TRANSIT_TO_CUSTOMER', 'out_for_delivery'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'SCANNED_BY_DRIVER_AND_IN_CAR', 'out_for_delivery'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'PARTIALLY_DELIVERED', 'out_for_delivery'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'PENDING_CUSTOMER_RECEIVING_CONFIRMATION', 'out_for_delivery'),

  ('shipment_status', 'logestechs_3pl', 'inbound', 'DELIVERED', 'delivered'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'DELIVERED_TO_RECIPIENT', 'delivered'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'COMPLETED', 'delivered'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'SWAPPED', 'delivered'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'COD_OUT_OF_ACCOUNTANT_CUSTODY', 'delivered'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'COD_RECEIVED_BY_ACCOUNTANT', 'delivered'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'COD_SORTED_BY_ACCOUNTANT', 'delivered'),

  ('shipment_status', 'logestechs_3pl', 'inbound', 'RETURNED_BY_RECIPIENT', 'return_to_origin'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'DELIVERED_TO_SENDER', 'return_to_origin'),

  ('shipment_status', 'logestechs_3pl', 'inbound', 'CANCELLED', 'cancelled'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'DELETED', 'cancelled'),

  ('shipment_status', 'logestechs_3pl', 'inbound', 'FAILED', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'FAILED_RECIPIENT_WASN_T_THERE', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'FAILED_PHONE_IS_TURNED_OFF', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'FAILED_ORDER_REFUSED', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'FAILED_NO_ANSWER_AFTER_ARRIVAL', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'FAILED_RECIPIENT_IS_NOT_ANSWERING', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'DAMAGED', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'LOST', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'OPENED_ISSUE_AND_WAITING_FOR_MANAGEMENT', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'REJECTED_BY_DRIVER_AND_PENDING_MANGEMENT', 'delivery_failed'),
  ('shipment_status', 'logestechs_3pl', 'inbound', 'UNRESOLVED_FAILURE', 'delivery_failed')
ON CONFLICT (mapping_domain, provider_name, direction, provider_value) DO UPDATE
SET canonical_value = EXCLUDED.canonical_value;

-- ---------------------------------------------------------------------------
-- 5) Workflow handler: shipment status update (mapping + update + forwarding)
-- ---------------------------------------------------------------------------
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
    v_tracking := NULLIF(v_transformed->>'packageId', '');
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
    v_response.operation_result := jsonb_build_object('status', 'skipped_missing_tracking');
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

  v_provider_status_norm := upper(v_provider_status_raw);
  v_provider_status_norm := regexp_replace(v_provider_status_norm, '[^A-Z0-9]+', '_', 'g');
  v_provider_status_norm := regexp_replace(v_provider_status_norm, '_{2,}', '_', 'g');
  v_provider_status_norm := NULLIF(btrim(v_provider_status_norm, '_'), '');

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

  SELECT canonical_value
    INTO v_canonical_status
    FROM public.field_mappings
   WHERE mapping_domain = 'shipment_status'
     AND provider_name = v_provider_name
     AND direction IN ('inbound', 'both')
     AND provider_value = v_provider_status_norm
   LIMIT 1;

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
      'provider_name', v_provider_name
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
      'provider_status', v_provider_status_norm
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

-- ---------------------------------------------------------------------------
-- 6) Register handler in operation_handlers
-- ---------------------------------------------------------------------------
INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  created_by,
  notes,
  doc_url
)
VALUES (
  'shipment_status_update',
  'workflow_handlers',
  'execute_shipment_status_update_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  NULL,
  'Inbound shipment status update handler (Logestechs and compatible sources).',
  'docs/ops/runbooks/logestechs-status-webhook-mirror.md'
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
-- 7) Workflow template + steps
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
  '99990000-0000-0000-0000-000000780001',
  'shipment_update_status_v1',
  'Apply inbound shipment status updates and forward client webhooks.',
  1,
  'active',
  'global',
  NULL,
  'Logestechs status webhook mirror workflow (row-driven, policy gated).'
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
  v_step_id UUID := '99990000-0000-0000-0000-000000780101'::uuid;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'shipment_update_status_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'shipment_update_status_v1 not found; skipping step insert';
    RETURN;
  END IF;

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
  ) VALUES (
    v_step_id,
    v_template_id,
    1,
    'shipment_status_update',
    'workflow',
    'always',
    'shipment_status_update',
    'v1',
    jsonb_build_object('max_retries', 3),
    FALSE,
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
  SET workflow_template_id = EXCLUDED.workflow_template_id,
      sequence_order = EXCLUDED.sequence_order,
      operation_name = EXCLUDED.operation_name,
      operation_settings_category = EXCLUDED.operation_settings_category,
      transition_condition = EXCLUDED.transition_condition,
      handler_key = EXCLUDED.handler_key,
      handler_version = EXCLUDED.handler_version,
      metadata = EXCLUDED.metadata,
      manual_action_required = EXCLUDED.manual_action_required,
      enabled = EXCLUDED.enabled,
      updated_at = now();

  PERFORM public.workflow_refresh_steps_checksum(v_template_id);
END;
$do$;

COMMIT;
