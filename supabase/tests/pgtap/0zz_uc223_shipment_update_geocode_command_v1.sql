-- Plan: UC223 shipment update geocode command / Step: S01
-- pgTAP: shipment update geocode command contract v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

CREATE OR REPLACE FUNCTION pg_temp.test_uc223_shipment_update_geocode_command_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_commands JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_address UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_result JSONB := NULL;
  v_workflow_run_id UUID := NULL;
  v_shipment_action_id UUID := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'ui_execute_shipment_update_geocode_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_shipment_update_geocode_v1 exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_shipment_update_geocode_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_shipment_update_geocode_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_shipment_update_geocode_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_execute_shipment_update_geocode_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege(
      'anon',
      'api.ui_execute_shipment_update_geocode_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'anon cannot execute api.ui_execute_shipment_update_geocode_v1'
  );

  SELECT cached_value
    INTO v_commands
    FROM public.settings
   WHERE category = 'ui_command_registry'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.update_geocode'
        AND item.value#>>'{execution,type}' = 'rpc'
        AND item.value#>>'{execution,rpc}' = 'ui_execute_shipment_update_geocode_v1'
    ),
    'ui_command_registry exposes shipments.update_geocode'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.update_geocode'
        AND item.value->>'schema_category' = 'resource:shipments'
    ),
    'shipments.update_geocode is tied to resource:shipments'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.update_geocode'
        AND item.value->>'capability' = 'shipments.write'
    ),
    'shipments.update_geocode requires shipments.write'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.update_geocode'
        AND item.value#>>'{selection,mode}' = 'single'
        AND item.value#>>'{selection,id_param}' = 'id'
    ),
    'shipments.update_geocode is single-selection only'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.update_geocode'
        AND item.value#>>'{execution,confirm,title}' = 'Requeue geocode?'
    ),
    'shipments.update_geocode includes a guarded confirm dialog'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_commands->'commands', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'shipments.update_geocode'
        AND item.value#>>'{execution,params,workflow_template_name}' = 'shipment_update_geocode_v1'
    ),
    'shipments.update_geocode targets shipment_update_geocode_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC223 Geocode Org', 'uc223-geocode-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client, v_org, 'UC223 Geocode Client', 'uc223-client-' || left(v_client::text, 8), 'standard', 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'UC223 Geocode Sender', 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_operator,
    v_org,
    'uc223-ops-' || left(v_operator::text, 8) || '@example.com',
    'UC223 Operator',
    'ops_admin',
    'tenant'
  );

  INSERT INTO public.addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    city,
    province,
    country,
    validation_status
  )
  VALUES (
    v_address,
    v_org,
    v_client,
    'UC223 address',
    'Riyadh',
    'Riyadh',
    'SA',
    'pending'
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    box_count,
    destination_address_id,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'UC223-' || upper(left(v_shipment::text, 8)),
    'pending',
    1,
    v_address,
    '{}'::jsonb,
    now(),
    now()
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_operator::text,
      'role', 'authenticated'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_execute_shipment_update_geocode_v1(
    'shipments.update_geocode',
    'shipments',
    ARRAY[v_shipment::text],
    v_shipment::text,
    1,
    '{}'::jsonb
  );

  BEGIN
    v_workflow_run_id := NULLIF(v_result->>'workflow_run_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_workflow_run_id := NULL;
  END;

  BEGIN
    v_shipment_action_id := NULLIF(v_result#>>'{items,0,shipment_action_id}', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_action_id := NULL;
  END;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(v_result->>'status', 'completed', 'api.ui_execute_shipment_update_geocode_v1 reports completed status');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.workflow_runs wr
      JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
      WHERE wr.id = v_workflow_run_id
        AND wt.name = 'shipment_update_geocode_v1'
        AND wr.workflow_status = 'completed'
    ),
    'shipment_update_geocode_v1 workflow run completes for the selected shipment'
  );
  RETURN NEXT is(
    (
      SELECT sa.action_type
      FROM public.shipment_actions sa
      WHERE sa.id = v_shipment_action_id
    ),
    'geocode_request',
    'shipment update geocode records a geocode_request shipment action'
  );
END;
$function$;

SELECT * FROM pg_temp.test_uc223_shipment_update_geocode_command_v1();

ROLLBACK;
