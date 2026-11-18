-- pgTAP: Console V2 shipment address amendment success contract.
-- Proves the browser-facing api wrapper starts the canonical workflow, persists
-- the replacement address, updates the shipment pointer, and records lineage.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_address_amend_success_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000087100001';
  v_ops UUID := '00000000-0000-0000-0000-000087100002';
  v_client UUID := '00000000-0000-0000-0000-000087100003';
  v_sender UUID := '00000000-0000-0000-0000-000087100004';
  v_old_address UUID := '00000000-0000-0000-0000-000087100005';
  v_shipment UUID := '00000000-0000-0000-0000-000087100006';
  v_result JSONB := '{}'::jsonb;
  v_new_address UUID;
  v_action UUID;
  v_run UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Address Amend Org', 'console-v2-address-amend')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_ops,
    v_org,
    'console-v2-address-amend@example.test',
    'Console V2 Address Amend',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'Console V2 Address Amend Client',
    'console-v2-address-amend-client',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (
    v_sender,
    v_client,
    'Console V2 Address Amend Sender',
    'Console V2 Address Amend Sender',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.upsert_settings_value_v1(
    'shipment_operation_policy',
    'tenant',
    v_org,
    jsonb_build_object(
      'version', 1,
      'address', jsonb_build_object(
        'allowed_statuses', jsonb_build_array('pending'),
        'workflow_template_name', 'shipment_update_address_v1',
        'default_country_code', 'SA',
        're_geocode', FALSE
      )
    ),
    1,
    'console v2 address amend success contract'
  );

  INSERT INTO public.addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    normalized_line1,
    city,
    province,
    country,
    validation_status
  )
  VALUES (
    v_old_address,
    v_org,
    v_client,
    'Old address',
    'Old address',
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
    tracking_number,
    client_reference_number,
    service_type,
    status,
    destination_address_id,
    metadata
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'PGTAP-ADDR-AMEND-8710-001',
    'PGTAP-ADDR-AMEND-8710-001',
    'delivery',
    'pending',
    v_old_address,
    '{}'::jsonb
  )
  ON CONFLICT (id, client_id) DO UPDATE
     SET destination_address_id = EXCLUDED.destination_address_id,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         updated_at = now();

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.shipment_amend_cancel_v1(
    jsonb_build_object(
      'shipment_id', v_shipment::text,
      'operation', 'address',
      'surface', 'console',
      'address', jsonb_build_object(
        'line1', 'New address pgtap 8710',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'province', 'Riyadh',
        'country', 'SA',
        'postal_code', '12345'
      ),
      'idempotency_key', 'pgtap-address-amend-8710'
    )
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT destination_address_id
    INTO v_new_address
    FROM public.shipments
   WHERE id = v_shipment
     AND client_id = v_client;

  v_action := NULLIF(v_result->>'shipment_action_id', '')::UUID;
  v_run := NULLIF(v_result->>'workflow_run_id', '')::UUID;

  RETURN NEXT ok(
    v_result->>'ok' = 'true'
    AND v_result->>'operation' = 'address',
    'api.shipment_amend_cancel_v1 accepts address amendment'
  );

  RETURN NEXT ok(
    v_run IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.workflow_runs
       WHERE id = v_run
    ),
    'address amendment creates canonical workflow run'
  );

  RETURN NEXT ok(
    v_new_address IS NOT NULL
    AND v_new_address <> v_old_address,
    'address amendment updates shipment destination_address_id'
  );

  RETURN NEXT is(
    (
      SELECT normalized_line1
        FROM public.addresses
       WHERE id = v_new_address
         AND client_id = v_client
    ),
    'New address pgtap 8710',
    'address amendment persists new normalized address'
  );

  RETURN NEXT ok(
    v_action IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.shipment_actions
       WHERE id = v_action
         AND shipment_id = v_shipment
         AND action_type = 'address_update'
         AND action_data->>'idempotency_key' = 'pgtap-address-amend-8710'
    ),
    'address amendment writes shipment action lineage'
  );
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_address_amend_success_v1();

SELECT * FROM finish();

ROLLBACK;
