-- Plan: Batch 8 proof-of-delivery signature contract / Step: E01
-- pgTAP: signature-required delivery handover modes must fail closed without a saved signature

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

CREATE OR REPLACE FUNCTION pg_temp.test_b08_pod_signature_required_handover_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_vehicle UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_created RECORD;
  v_route_stop_id UUID;
  v_task_created RECORD;
  v_task_id UUID;
  v_task_done_event_id UUID;
  v_signature_artifact_id UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'enforce_delivery_signature_task_event_v1',
    ARRAY[]::TEXT[],
    'public.enforce_delivery_signature_task_event_v1() exists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'task_events'
        AND t.tgname = 'trg_task_events_delivery_signature_enforce'
        AND NOT t.tgisinternal
    ),
    'task_events delivery-signature trigger exists'
  );
  RETURN NEXT is(
    (
      SELECT COALESCE((lv.metadata->>'requires_signature')::boolean, false)
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'delivery_handover_mode'
        AND lower(lv.value) = 'named_recipient'
      ORDER BY lv.sort_order NULLS LAST, lv.created_at, lv.id
      LIMIT 1
    ),
    true,
    'named_recipient handover mode requires signature'
  );
  RETURN NEXT is(
    (
      SELECT COALESCE((lv.metadata->>'requires_signature')::boolean, false)
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'delivery_handover_mode'
        AND lower(lv.value) = 'mailroom'
      ORDER BY lv.sort_order NULLS LAST, lv.created_at, lv.id
      LIMIT 1
    ),
    false,
    'mailroom handover mode does not require signature'
  );

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B08 POD Signature Org', 'b08-pod-signature-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'b08-pod-signature-' || left(v_user::text, 8) || '@example.com',
    'B08 POD Signature User',
    'driver',
    'tenant'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'b08-' || left(v_branch::text, 8), 'B08 POD Signature Branch', 'Asia/Riyadh', true);

  INSERT INTO public.vehicles (id, organization_id, status, is_active)
  VALUES (v_vehicle, v_org, 'active', true);

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status, settings_override)
  VALUES (
    v_client,
    v_org,
    'B08 POD Signature Client',
    'b08-pod-signature-' || left(v_client::text, 8),
    'standard',
    'active',
    '{}'::jsonb
  );

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'B08 POD Signature Sender', 'B08 POD Signature Sender', TRUE, 'active');

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:b08-pod-signature-fixture-bootstrap');

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    shipment_settings_override,
    metadata
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'B08-POD-' || left(v_shipment::text, 8),
    'out_for_delivery',
    '{}'::jsonb,
    jsonb_build_object('source', 'pgtap-b08-pod-signature')
  );

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'driver_user_id', v_user,
        'vehicle_id', v_vehicle,
        'idempotency_key', 'pgtap-b08-pod-signature-route-run',
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

  v_route_stop_id := (v_created.stop_ids)[1];
  RETURN NEXT ok(v_route_stop_id IS NOT NULL, 'create_route_run_v1 returns delivery stop');

  SELECT *
    INTO v_task_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org, 'client_id', v_client),
        'resource_type', 'route_stop',
        'resource_id', v_route_stop_id,
        'idempotency_key', 'pgtap-b08-pod-signature-task',
        'actor_system', 'dispatch_engine'
      )
    )
    LIMIT 1;

  v_task_id := v_task_created.task_id;
  RETURN NEXT ok(v_task_id IS NOT NULL, 'create_task_system_v1 creates route_stop task');

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
        FROM public.transition_task_v1(
          p_task_id := '%1$s'::uuid,
          p_to_status := 'completed',
          p_status_reason := 'delivered',
          p_payload := jsonb_build_object(
            'handover_mode', 'named_recipient',
            'recipient_name', 'Faisal QA',
            'completion_notes', 'signature missing should fail'
          ),
          p_idempotency_key := 'pgtap-b08-pod-signature-missing'
        )
      $sql$,
      v_task_id
    ),
    '23514',
    'delivery handover mode named_recipient requires signature_artifact_id',
    'named_recipient completion fails closed without signature'
  );

  SELECT task_event_id
    INTO v_task_done_event_id
    FROM public.transition_task_v1(
      p_task_id := v_task_id,
      p_to_status := 'completed',
      p_status_reason := 'delivered',
      p_payload := jsonb_build_object(
        'handover_mode', 'named_recipient',
        'recipient_name', 'Faisal QA',
        'completion_notes', 'signature-backed handoff',
        'signature_artifact_id', v_signature_artifact_id::text,
        'pod', jsonb_build_object(
          'signature_artifact_id', v_signature_artifact_id::text
        )
      ),
      p_idempotency_key := 'pgtap-b08-pod-signature-present'
    )
    LIMIT 1;

  RETURN NEXT ok(v_task_done_event_id IS NOT NULL, 'named_recipient completion succeeds with signature');
  RETURN NEXT is(
    (SELECT payload->>'signature_artifact_id' FROM public.task_events WHERE id = v_task_done_event_id),
    v_signature_artifact_id::text,
    'task_events payload stores signature_artifact_id'
  );
  RETURN NEXT is(
    (SELECT payload #>> '{pod,signature_artifact_id}' FROM public.task_events WHERE id = v_task_done_event_id),
    v_signature_artifact_id::text,
    'task_events payload normalizes pod.signature_artifact_id'
  );
  RETURN NEXT ok(
    (
      SELECT COALESCE(payload->'artifact_ids', '[]'::jsonb) ? v_signature_artifact_id::text
      FROM public.task_events
      WHERE id = v_task_done_event_id
    ),
    'task_events payload adds signature artifact to artifact_ids'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_b08_pod_signature_required_handover_v1();

SELECT * FROM finish();

ROLLBACK;
