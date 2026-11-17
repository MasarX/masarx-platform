-- pgTAP: UC224 shipment batch operation UI contract v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

CREATE OR REPLACE FUNCTION pg_temp.test_uc224_shipment_batch_operation_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_shipment_one UUID := gen_random_uuid();
  v_shipment_two UUID := gen_random_uuid();
  v_batch_result JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_function(
    'public',
    'ui_execute_shipment_batch_operation_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_shipment_batch_operation_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_shipment_batch_operation_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_shipment_batch_operation_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_shipment_batch_operation_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_execute_shipment_batch_operation_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.delete'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_shipment_batch_operation_v1'
        AND item.value#>>'{execution,params,operation}' = 'cancel'
    ),
    'ui_command_registry rewires shipments.delete onto the dedicated batch RPC'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.reschedule'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_shipment_batch_operation_v1'
        AND item.value#>>'{execution,params,operation}' = 'reschedule'
        AND item.value#>>'{execution,input_schema,fields,0,key}' = 'slot_date'
    ),
    'ui_command_registry exposes shipments.reschedule with required slot_date input'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC224 pgTap Org', 'uc224-pgtap-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'UC224 pgTap Client', 'uc224-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'UC224 Sender', 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_user, v_org, 'uc224-ops-' || left(v_user::text, 8) || '@example.com', 'UC224 Ops', 'ops_admin', 'active', 'tenant');

  PERFORM public.upsert_settings_value_v1(
    'shipment_operation_policy',
    'tenant',
    v_org,
    jsonb_build_object(
      'version', 1,
      'modify', jsonb_build_object(
        'allowed_statuses', jsonb_build_array('pending'),
        'workflow_template_name', 'shipment_modify_v1',
        'allowed_fields', jsonb_build_array('service_level')
      ),
      'address', jsonb_build_object(
        'allowed_statuses', jsonb_build_array('pending'),
        'workflow_template_name', 'shipment_update_address_v1',
        'default_country_code', 'SA'
      ),
      'reschedule', jsonb_build_object(
        'allowed_statuses', jsonb_build_array('pending'),
        'workflow_template_name', 'shipment_reschedule_v1'
      ),
      'delete', jsonb_build_object(
        'allowed_statuses', jsonb_build_array('pending'),
        'mode', 'soft_cancel',
        'window_hours', 24,
        'workflow_template_name', 'shipment_delete_v1'
      )
    ),
    1,
    'uc224 pgtap seed'
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    tracking_number,
    service_type,
    service_level,
    status,
    created_at,
    updated_at
  )
  VALUES
    (
      v_shipment_one,
      v_org,
      v_client,
      v_sender,
      'UC224-PGTAP-1',
      'delivery',
      'standard',
      'pending',
      now(),
      now()
    ),
    (
      v_shipment_two,
      v_org,
      v_client,
      v_sender,
      'UC224-PGTAP-2',
      'delivery',
      'standard',
      'pending',
      now(),
      now()
    );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_batch_result := api.ui_execute_shipment_batch_operation_v1(
    'shipments.delete',
    'shipments',
    ARRAY[v_shipment_one::text, v_shipment_two::text],
    NULL,
    2,
    '{}'::jsonb
  );

  RETURN NEXT is(v_batch_result->>'status', 'cancelled', 'batch shipment delete reports cancelled status');
  RETURN NEXT is(v_batch_result->>'success_count', '2', 'batch shipment delete reports two successful items');
  RETURN NEXT is(jsonb_array_length(COALESCE(v_batch_result->'items', '[]'::jsonb))::text, '2', 'batch shipment delete returns one item per selected shipment');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment_one),
    'cancelled',
    'first selected shipment is soft-cancelled'
  );
  RETURN NEXT is(
    (SELECT status FROM public.shipments WHERE id = v_shipment_two),
    'cancelled',
    'second selected shipment is soft-cancelled'
  );
  RETURN NEXT is(
    (
      SELECT COUNT(*)::text
      FROM public.workflow_runs wr
      JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
      WHERE wt.name = 'shipment_delete_v1'
        AND wr.workflow_status = 'completed'
        AND wr.context->>'shipment_id' IN (v_shipment_one::text, v_shipment_two::text)
    ),
    '2',
    'batch shipment delete starts canonical shipment_delete_v1 workflow runs for both shipments'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_uc224_shipment_batch_operation_v1();

SELECT * FROM finish();

ROLLBACK;
