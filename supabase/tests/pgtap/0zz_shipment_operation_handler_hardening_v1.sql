BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(20);

DO $block$
DECLARE
  v_org_id UUID := '7aa00000-0000-0000-0000-000000000001';
  v_client_id UUID := '7aa00000-0000-0000-0000-000000000002';
  v_sender_id UUID := '7aa00000-0000-0000-0000-000000000003';
  v_driver_active_id UUID := '7aa00000-0000-0000-0000-000000000004';
  v_driver_inactive_id UUID := '7aa00000-0000-0000-0000-000000000005';
  v_shipment_id UUID := '7aa00000-0000-0000-0000-000000000011';
  v_shipment_conflict_id UUID := '7aa00000-0000-0000-0000-000000000012';
  v_shipment_expired_id UUID := '7aa00000-0000-0000-0000-000000000013';
  v_address_id UUID := '7aa00000-0000-0000-0000-000000000021';
  v_run public.workflow_runs;
  v_step public.workflow_run_steps;
  v_response public.workflow_handler_response;
  v_policy JSONB;
  v_policy_scope RECORD;
  v_many_attachments JSONB := '[]'::jsonb;
  v_action_timestamp TIMESTAMPTZ := '2026-03-10T12:34:56Z'::timestamptz;
  v_saved_action_id UUID;
  v_saved_timestamp TEXT;
  i INT;
BEGIN
  INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (v_org_id, 'pgTAP Shipment Handler Org', 'pgtap-shipment-handler-org', 'Asia/Riyadh', 'en-US', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client_id, v_org_id, 'pgTAP Shipment Handler Client', 'pgtap-shipment-handler-client', 'standard', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender_id, v_client_id, 'pgTAP Sender', 'pgTAP Sender', TRUE, 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES
    (v_driver_active_id, v_org_id, 'driver-active@pgtap.example', 'Driver Active', 'driver', 'active'),
    (v_driver_inactive_id, v_org_id, 'driver-inactive@pgtap.example', 'Driver Inactive', 'driver', 'suspended')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    city,
    province,
    country,
    validation_status
  ) VALUES (
    v_address_id,
    v_org_id,
    v_client_id,
    'pgTAP geocode address',
    'Riyadh',
    'Riyadh',
    'SA',
    'pending'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    client_reference_number,
    carrier_reference_number,
    box_count,
    destination_address_id,
    status,
    status_updated_at,
    created_at,
    updated_at
  ) VALUES
    (
      v_shipment_id,
      v_org_id,
      v_client_id,
      v_sender_id,
      'delivery',
      'PGTAP-HARDEN-001',
      'CLIENT-001',
      'CARRIER-001',
      1,
      v_address_id,
      'pending',
      now(),
      now(),
      now()
    ),
    (
      v_shipment_conflict_id,
      v_org_id,
      v_client_id,
      v_sender_id,
      'delivery',
      'PGTAP-HARDEN-002',
      'CLIENT-002',
      'CARRIER-002',
      1,
      NULL,
      'pending',
      now(),
      now(),
      now()
    ),
    (
      v_shipment_expired_id,
      v_org_id,
      v_client_id,
      v_sender_id,
      'delivery',
      'PGTAP-HARDEN-003',
      'CLIENT-003',
      'CARRIER-003',
      1,
      NULL,
      'pending',
      now(),
      now() - interval '48 hours',
      now()
    )
  ON CONFLICT (id, client_id) DO NOTHING;

  PERFORM public.upsert_shipment_reference_numbers_v1(
    v_org_id,
    v_client_id,
    v_shipment_id,
    jsonb_build_object(
      'client_reference_number', 'CLIENT-001',
      'carrier_reference_number', 'CARRIER-001',
      'logistics_reference_number', jsonb_build_array('LOG-OLD')
    ),
    'workflow',
    gen_random_uuid(),
    jsonb_build_object('test', 'seed')
  );

  v_run := jsonb_populate_record(
    NULL::public.workflow_runs,
    jsonb_build_object(
      'id', gen_random_uuid(),
      'workflow_template_id', gen_random_uuid(),
      'workflow_template_version', 1,
      'entry_point', 'webhook',
      'workflow_status', 'pending',
      'retry_count', 0,
      'version', 1,
      'created_at', now(),
      'updated_at', now(),
      'context', '{}'::jsonb
    )
  );

  v_step := jsonb_populate_record(
    NULL::public.workflow_run_steps,
    jsonb_build_object(
      'id', gen_random_uuid(),
      'workflow_run_id', v_run.id,
      'workflow_template_step_id', gen_random_uuid(),
      'sequence_order', 1,
      'operation_name', 'shipment-handler-test',
      'manual_action_required', FALSE,
      'metadata', '{}'::jsonb,
      'enabled', TRUE,
      'handler_key', 'shipment_handler_test',
      'handler_version', 'v1',
      'step_status', 'pending',
      'retry_attempt', 0,
      'max_retries', 1,
      'created_at', now(),
      'updated_at', now(),
      'run_at', now(),
      'enqueued_at', now(),
      'runtime_state', '{}'::jsonb
    )
  );

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'shipment_id', v_shipment_id,
    'event', jsonb_build_object('id', 'evt-geocode-enqueue')
  );
  v_response := workflow_handlers.execute_shipment_update_geocode_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.status, 'completed', 'geocode updates complete when the shipment already carries destination_address_id');
  PERFORM ok(
    NULLIF(v_response.operation_result->>'geocode_workflow_run_id', '') IS NOT NULL,
    'geocode updates enqueue the configured geocoding workflow'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM pg_proc p
      WHERE p.pronamespace = 'workflow_handlers'::regnamespace
        AND p.proname = 'record_shipment_action_v1'
        AND p.oid::regprocedure::text = 'workflow_handlers.record_shipment_action_v1(uuid,text,text,jsonb,text,text,text,uuid,timestamp with time zone)'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      WHERE p.pronamespace = 'workflow_handlers'::regnamespace
        AND p.proname = 'record_shipment_action_v1'
        AND p.oid::regprocedure::text = 'workflow_handlers.record_shipment_action_v1(uuid,text,text,jsonb,text,text,text,uuid)'
    ),
    'shipment action recording keeps a single canonical signature to avoid overload ambiguity'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.shipment_actions sa
      WHERE sa.shipment_id = v_shipment_id
        AND sa.action_type = 'geocode_request'
        AND sa.performed_by_system = 'workflow_handlers.execute_shipment_update_geocode_v1'
    ),
    'geocode updates record canonical shipment actions without overload ambiguity'
  );

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'shipment_id', v_shipment_id,
    'event', jsonb_build_object('id', 'evt-modify-bad-cod'),
    'changes', jsonb_build_object('cod_amount', 'not-a-number')
  );
  v_response := workflow_handlers.execute_shipment_modify_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'cod_amount_invalid', 'modify rejects invalid cod_amount values');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'shipment_id', v_shipment_id,
    'event', jsonb_build_object('id', 'evt-modify-conflict'),
    'changes', jsonb_build_object('client_reference_number', 'CLIENT-002')
  );
  v_response := workflow_handlers.execute_shipment_modify_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'client_reference_number_conflict', 'modify returns structured client reference conflicts');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'shipment_id', v_shipment_id,
    'event', jsonb_build_object('id', 'evt-modify-sync'),
    'changes', jsonb_build_object(
      'client_reference_number', 'CLIENT-010',
      'carrier_reference_number', 'CARRIER-010',
      'references', jsonb_build_object(
        'logistics_reference_number', jsonb_build_array('LOG-010-A', 'LOG-010-B')
      )
    )
  );
  v_response := workflow_handlers.execute_shipment_modify_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.status, 'completed', 'modify completes with canonical reference syncing');
  PERFORM is(
    (SELECT s.client_reference_number FROM public.shipments s WHERE s.id = v_shipment_id AND s.client_id = v_client_id),
    'CLIENT-010',
    'modify updates the shipment client_reference_number projection'
  );
  PERFORM ok(
    NOT EXISTS (
      SELECT 1
      FROM public.shipment_reference_numbers srn
      WHERE srn.shipment_id = v_shipment_id
        AND srn.client_id = v_client_id
        AND srn.reference_type = 'client_reference_number'
        AND srn.reference_value = 'CLIENT-001'
    ),
    'reference sync removes stale canonical client_reference_number rows'
  );
  PERFORM is(
    (SELECT COUNT(*)::TEXT
     FROM public.shipment_reference_numbers srn
     WHERE srn.shipment_id = v_shipment_id
       AND srn.client_id = v_client_id
       AND srn.reference_type = 'logistics_reference_number'),
    '2',
    'reference sync replaces logistics references with the supplied canonical set'
  );

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'event', jsonb_build_object('id', 'evt-address-missing'),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'PGTAP-HARDEN-001'),
      'destination_address', jsonb_build_object('city', 'Riyadh')
    )
  );
  v_response := workflow_handlers.execute_shipment_update_address_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'address_fields_missing', 'address update fails when required fields are missing');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'shipment_id', v_shipment_expired_id,
    'event', jsonb_build_object('id', 'evt-delete-expired')
  );
  v_response := workflow_handlers.execute_shipment_delete_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'shipment_delete_window_expired', 'delete fails once the configured delete window expires');

  SELECT *
    INTO v_policy_scope
    FROM public.resolve_settings_row_from_context(
      'shipment_operation_policy',
      jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id
      )
    )
   LIMIT 1;

  v_policy := public.resolve_shipment_operation_policy_v1(
    jsonb_build_object(
      'organization_id', v_org_id,
      'client_id', v_client_id
    )
  );
  v_policy := jsonb_set(v_policy, '{delete,mode}', to_jsonb('hard_delete'::TEXT), TRUE);
  PERFORM public.upsert_settings_value_v1(
    'shipment_operation_policy',
    COALESCE(v_policy_scope.scope_type, 'global'),
    v_policy_scope.scope_id,
    v_policy,
    1,
    'pgTAP shipment delete mode override at the current resolved scope'
  );

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'shipment_id', v_shipment_id,
    'event', jsonb_build_object('id', 'evt-delete-mode')
  );
  v_response := workflow_handlers.execute_shipment_delete_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'shipment_delete_mode_not_supported', 'delete fails closed when policy mode is not soft_cancel');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'event', jsonb_build_object('id', 'evt-driver-inactive'),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'PGTAP-HARDEN-001'),
      'driver', jsonb_build_object('user_id', v_driver_inactive_id)
    )
  );
  v_response := workflow_handlers.execute_shipment_update_driver_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'driver_not_active', 'driver updates require active users in the same organization and accept transformed_payload.driver.user_id');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'event', jsonb_build_object('id', 'evt-action-fields'),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'PGTAP-HARDEN-001'),
      'action', jsonb_build_object('occurred_at', '2026-03-10T10:00:00Z', 'notes', 'missing taxonomy')
    )
  );
  v_response := workflow_handlers.execute_shipment_update_action_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'action_fields_missing', 'action updates fail when taxonomy fields are missing');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'event', jsonb_build_object('id', 'evt-action-occurred-at'),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'PGTAP-HARDEN-001'),
      'action', jsonb_build_object('action_type', 'note', 'action_category', 'operational')
    )
  );
  v_response := workflow_handlers.execute_shipment_update_action_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'action_occurred_at_missing', 'action updates require occurred_at');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'event', jsonb_build_object('id', 'evt-action-valid'),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'PGTAP-HARDEN-001'),
      'action', jsonb_build_object(
        'action_type', 'note',
        'action_category', 'operational',
        'occurred_at', '2026-03-10T12:34:56Z',
        'notes', 'Recorded from provider'
      )
    )
  );
  v_response := workflow_handlers.execute_shipment_update_action_v1(v_step, v_run, '{}'::jsonb);
  v_saved_action_id := NULLIF(v_response.operation_result->>'shipment_action_id', '')::UUID;
  SELECT to_char(sa.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    INTO v_saved_timestamp
    FROM public.shipment_actions sa
   WHERE sa.id = v_saved_action_id;
  PERFORM is(v_saved_timestamp, '2026-03-10T12:34:56Z', 'action updates persist the supplied occurred_at timestamp');

  FOR i IN 1..11 LOOP
    v_many_attachments := v_many_attachments || jsonb_build_array(
      jsonb_build_object(
        'content_url', format('https://example.com/%s.pdf', i),
        'mime_type', 'application/pdf',
        'size_bytes', 1024
      )
    );
  END LOOP;

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'event', jsonb_build_object('id', 'evt-attachment-count'),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'PGTAP-HARDEN-001'),
      'attachments', v_many_attachments
    )
  );
  v_response := workflow_handlers.execute_shipment_update_attachment_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'attachment_item_count_exceeded', 'attachment updates enforce attachment.max_items_per_event');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'event', jsonb_build_object('id', 'evt-attachment-mime'),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'PGTAP-HARDEN-001'),
      'attachment', jsonb_build_object(
        'content_url', 'https://example.com/evidence.zip',
        'mime_type', 'application/zip',
        'size_bytes', 1024
      )
    )
  );
  v_response := workflow_handlers.execute_shipment_update_attachment_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.last_error, 'attachment_mime_not_allowed', 'attachment updates fail when mime_type is outside policy allowlist');

  v_run.context := jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'event', jsonb_build_object('id', 'evt-attachment-multi'),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object('tracking_number', 'PGTAP-HARDEN-001'),
      'attachments', jsonb_build_array(
        jsonb_build_object(
          'content_url', 'https://example.com/evidence-1.pdf',
          'mime_type', 'application/pdf',
          'size_bytes', 1024
        ),
        jsonb_build_object(
          'content_url', 'https://example.com/evidence-2.png',
          'mime_type', 'image/png',
          'size_bytes', 2048
        )
      )
    )
  );
  v_response := workflow_handlers.execute_shipment_update_attachment_v1(v_step, v_run, '{}'::jsonb);
  PERFORM is(v_response.operation_result->>'artifact_count', '2', 'attachment updates process transformed_payload attachments up to policy limits');
END;
$block$;

SELECT * FROM finish();

ROLLBACK;
