-- Plan: Batch 8 proof-of-delivery identity + asset visibility contract / Step: E05
-- pgTAP: alternate POD proof must normalize OTP/identity metadata and expose shipment POD assets through browser-safe RPCs

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

CREATE OR REPLACE FUNCTION pg_temp.test_b08_pod_identity_asset_visibility_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_ops_user UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_other_shipment UUID := gen_random_uuid();
  v_created RECORD;
  v_route_stop_id UUID;
  v_route_run_id UUID;
  v_task_created RECORD;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_domain_event_id UUID;
  v_domain_event_run_id UUID;
  v_run_status TEXT;
  v_iter INT;
  v_step_error TEXT;
  v_photo_artifact_id UUID;
  v_signature_artifact_id UUID;
  v_asset_count INT := 0;
  v_asset_kinds TEXT[] := ARRAY[]::TEXT[];
  v_download_bucket TEXT := NULL;
  v_download_key TEXT := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.schema_registry
      WHERE category = 'pod_policy'
        AND version = 3
        AND COALESCE((schema #>> '{properties,requirements,properties,completed,properties,identity_confirmation_required,type,0}'), '') = 'boolean'
        AND is_active IS TRUE
    ),
    'pod_policy v3 schema includes identity_confirmation_required'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS command(item)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(command.item #> '{execution,input_schema,fields}', '[]'::jsonb)) AS field(item)
      WHERE s.category = 'ui_command_registry'
        AND field.item->>'key' = 'otp_code'
    ),
    'ui_command_registry exposes otp_code on tasks.complete'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS command(item)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(command.item #> '{execution,input_schema,fields}', '[]'::jsonb)) AS field(item)
      WHERE s.category = 'ui_command_registry'
        AND field.item->>'key' = 'recipient_identity_kind'
    ),
    'ui_command_registry exposes recipient_identity_kind on tasks.complete'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS command(item)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(command.item #> '{execution,input_schema,fields}', '[]'::jsonb)) AS field(item)
      WHERE s.category = 'ui_command_registry'
        AND field.item->>'key' = 'recipient_identity_last4'
    ),
    'ui_command_registry exposes recipient_identity_last4 on tasks.complete'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.operation_handlers
      WHERE handler_key = 'route_stop_finalize'
        AND handler_name = 'execute_route_stop_finalize_v9'
        AND handler_version = 'v9'
        AND is_active IS TRUE
    ),
    'route_stop_finalize handler upgraded to v9'
  );
  RETURN NEXT has_function(
    'api',
    'ui_list_shipment_pod_assets_v1',
    ARRAY['uuid'],
    'api.ui_list_shipment_pod_assets_v1(uuid) exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_get_shipment_pod_asset_download_v1',
    ARRAY['uuid', 'uuid'],
    'api.ui_get_shipment_pod_asset_download_v1(uuid, uuid) exists'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B08 POD Identity Org', 'b08-pod-identity-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_driver,
    v_org,
    'b08-pod-identity-' || left(v_driver::text, 8) || '@example.com',
    'B08 POD Identity Driver',
    'driver',
    'tenant'
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_ops_user,
    v_org,
    'b08-pod-assets-' || left(v_ops_user::text, 8) || '@example.com',
    'B08 POD Assets Ops User',
    'ops_admin',
    'tenant'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'b08-' || left(v_branch::text, 8), 'B08 POD Identity Branch', 'UTC', TRUE);

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B08 POD Identity Client', 'b08-pod-identity-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'B08 POD Identity Sender', 'B08 POD Identity Sender', TRUE, 'active');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', 'B08PODID' || upper(left(v_shipment::text, 8)), 'out_for_delivery');

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_other_shipment, v_org, v_client, v_sender, 'delivery', 'B08PODALT' || upper(left(v_other_shipment::text, 8)), 'out_for_delivery');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT artifact_id
    INTO v_photo_artifact_id
    FROM public.register_artifact_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'storage_bucket', 'fieldops-evidence',
        'storage_key', v_org::text || '/pgtap/pod-identity-photo.jpg',
        'mime_type', 'image/jpeg',
        'size_bytes', 1024,
        'sha256', repeat('d', 64),
        'source_system', 'fieldops_mobile',
        'metadata', jsonb_build_object('artifact_kind', 'photo', 'source', 'pgtap')
      )
    )
   LIMIT 1;

  SELECT artifact_id
    INTO v_signature_artifact_id
    FROM public.register_artifact_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'storage_bucket', 'fieldops-evidence',
        'storage_key', v_org::text || '/pgtap/pod-identity-signature.svg',
        'mime_type', 'image/svg+xml',
        'size_bytes', 768,
        'sha256', repeat('e', 64),
        'source_system', 'fieldops_mobile',
        'metadata', jsonb_build_object('artifact_kind', 'signature', 'source', 'pgtap')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_photo_artifact_id IS NOT NULL AND v_signature_artifact_id IS NOT NULL, 'photo and signature artifacts seeded');

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_driver,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-b08-pod-identity-route-run',
        'stops', jsonb_build_array(
          jsonb_build_object(
            'client_id', v_client,
            'shipment_id', v_shipment,
            'stop_kind', 'delivery',
            'sequence_order', 1
          )
        )
      )
    )
    LIMIT 1;

  v_route_run_id := v_created.route_run_id;
  v_route_stop_id := (v_created.stop_ids)[1];
  RETURN NEXT ok(v_route_stop_id IS NOT NULL AND v_route_run_id IS NOT NULL, 'create_route_run_v1 returns delivery stop and route run');

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client, 'sender_id', v_sender),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-b08-pod-identity-task',
        'actor_system', 'dispatch_engine'
      )
    )
    LIMIT 1;

  v_task_id := v_task_created.task_id;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'create_task_system_v1 creates route_stop task');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'delivered',
      p_payload := jsonb_build_object(
        'handover_mode', 'named_recipient',
        'recipient_name', 'Faisal QA',
        'signature_artifact_id', v_signature_artifact_id::text,
        'artifact_ids', jsonb_build_array(v_signature_artifact_id, v_photo_artifact_id),
        'otp_code', '123456',
        'recipient_identity_kind', 'national_id',
        'recipient_identity_last4', 'AB6789',
        'pod', jsonb_build_object(
          'captured_at', '2026-04-08T08:15:30Z',
          'signature_artifact_id', v_signature_artifact_id::text,
          'artifact_ids', jsonb_build_array(v_signature_artifact_id, v_photo_artifact_id),
          'otp_code', '123456',
          'recipient_identity_kind', 'national_id',
          'recipient_identity_last4', 'AB6789'
        )
      ),
      p_idempotency_key := 'pgtap-b08-pod-identity-done'
    )
    LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'completed delivery task_event created');
  RETURN NEXT ok(
    (SELECT payload ? 'otp_code' FROM public.task_events WHERE id = v_task_done_event_id) IS FALSE,
    'task_events payload strips raw otp_code'
  );
  RETURN NEXT is(
    (SELECT payload->>'otp_last4' FROM public.task_events WHERE id = v_task_done_event_id),
    '3456',
    'task_events payload stores sanitized otp_last4'
  );
  RETURN NEXT is(
    (SELECT payload->>'recipient_identity_last4' FROM public.task_events WHERE id = v_task_done_event_id),
    '6789',
    'task_events payload stores normalized identity last 4'
  );

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT id, workflow_run_id
    INTO v_domain_event_id, v_domain_event_run_id
  FROM public.domain_events de
  WHERE de.organization_id = v_org
    AND de.event_type = 'task.completed.route_stop_execute'
    AND (de.payload->>'task_event_id') = v_task_done_event_id::text
  ORDER BY de.created_at DESC
  LIMIT 1;

  FOR v_iter IN 1..50 LOOP
    UPDATE public.cron_config SET last_run_at = NULL WHERE worker_name = 'domain_events_worker';
    PERFORM public.run_domain_events_worker();
    SELECT workflow_run_id
      INTO v_domain_event_run_id
    FROM public.domain_events
    WHERE id = v_domain_event_id;
    EXIT WHEN v_domain_event_run_id IS NOT NULL;
  END LOOP;

  FOR v_iter IN 1..50 LOOP
    SELECT workflow_status INTO v_run_status FROM public.workflow_runs WHERE id = v_domain_event_run_id;
    EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled');
    PERFORM public.progress_workflow_run(v_domain_event_run_id);
  END LOOP;

  IF v_run_status IS DISTINCT FROM 'completed' THEN
    SELECT COALESCE(last_error, '')::text
      INTO v_step_error
      FROM public.workflow_run_steps
     WHERE workflow_run_id = v_domain_event_run_id
       AND sequence_order = 1
     LIMIT 1;
    RETURN NEXT diag('route_stop_finalize last_error=' || COALESCE(NULLIF(v_step_error, ''), '<empty>'));
  END IF;

  RETURN NEXT is(v_run_status, 'completed', 'route_stop finalize workflow completes with alternate proof payload');
  RETURN NEXT is(
    (SELECT pod_otp_last4 FROM public.shipment_actions WHERE shipment_id = v_shipment ORDER BY created_at DESC LIMIT 1),
    '3456',
    'shipment_actions stores pod_otp_last4'
  );
  RETURN NEXT is(
    (SELECT pod_identity_kind FROM public.shipment_actions WHERE shipment_id = v_shipment ORDER BY created_at DESC LIMIT 1),
    'national_id',
    'shipment_actions stores pod_identity_kind'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT COUNT(*), COALESCE(array_agg(asset_kind ORDER BY asset_kind), ARRAY[]::TEXT[])
    INTO v_asset_count, v_asset_kinds
  FROM api.ui_list_shipment_pod_assets_v1(v_shipment);

  RETURN NEXT is(v_asset_count, 2, 'shipment POD asset list returns linked artifacts');
  RETURN NEXT ok(v_asset_kinds @> ARRAY['photo', 'signature'], 'shipment POD asset list distinguishes photo and signature kinds');

  SELECT storage_bucket, storage_key
    INTO v_download_bucket, v_download_key
  FROM api.ui_get_shipment_pod_asset_download_v1(v_shipment, v_photo_artifact_id)
  LIMIT 1;

  RETURN NEXT is(v_download_bucket, 'fieldops-evidence', 'shipment POD asset download resolves storage bucket');
  RETURN NEXT ok(v_download_key LIKE '%' || 'pod-identity-photo.jpg', 'shipment POD asset download resolves storage key');
  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
        FROM api.ui_get_shipment_pod_asset_download_v1('%1$s'::uuid, '%2$s'::uuid)
      $sql$,
      v_other_shipment,
      v_photo_artifact_id
    ),
    'P0002',
    format(
      'ui_get_shipment_pod_asset_download_v1 artifact %s is not available for shipment %s',
      v_photo_artifact_id,
      v_other_shipment
    ),
    'shipment POD asset download rejects artifacts linked to a different shipment'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_b08_pod_identity_asset_visibility_v1();

SELECT * FROM finish();

ROLLBACK;
