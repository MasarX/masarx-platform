BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(4);

CREATE FUNCTION pg_temp.check_fieldops_lookup_and_cash_policy() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $fixture$
DECLARE
  v_org UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_recipient UUID := gen_random_uuid();
  v_address UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_policy JSONB;
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', TRUE);
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Synthetic FieldOps tenant', 'fieldops-policy-' || v_org);
  PERFORM set_config('app.organization_onboarding_source', '', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (v_actor, v_org, 'fieldops-' || v_actor || '@example.test', 'Synthetic driver', 'driver', 'active');
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Synthetic FieldOps client', 'fieldops-client-' || v_client, 'active');
  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number)
  VALUES (v_recipient, v_org, v_client, 'Synthetic recipient', '+12025550100');
  INSERT INTO public.addresses (id, organization_id, client_id, raw_input, city, province, validation_status)
  VALUES (v_address, v_org, v_client, 'Synthetic destination', 'Fixture city', 'Fixture province', 'pending');
  INSERT INTO public.shipments (
    id, organization_id, client_id, recipient_id, destination_address_id,
    service_type, tracking_number, client_reference_number, status
  ) VALUES (
    v_shipment, v_org, v_client, v_recipient, v_address,
    'delivery', 'TRACK-FIXTURE', 'CLIENT-FIXTURE', 'pending'
  );

  v_policy := public.resolve_settings('mobile_cash_policy', 'global', NULL);
  PERFORM public.upsert_settings_value_v1(
    'mobile_cash_policy', 'tenant', v_org,
    v_policy || '{"safe_location":"Fixture safe","default_expected_sar":17}'::jsonb,
    1, 'Exercise tenant cash policy readback'
  );

  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_actor)::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  RETURN NEXT is(api.resolve_fieldops_lookup_v1('driver', '{}', 'CLIENT-FIXTURE') #>> '{records,0,id}', v_shipment::text,
    'FieldOps finds shipments by client reference');
  RETURN NEXT is(api.resolve_fieldops_lookup_v1('driver', '{}', 'Synthetic recipient') #>> '{records,0,area}', 'Fixture city',
    'FieldOps recipient lookup returns the shipment destination city');
  RETURN NEXT is(api.resolve_fieldops_cash_drop_v1() ->> 'safe_location', 'Fixture safe',
    'cash drop reads the tenant safe location');
  RETURN NEXT is(api.resolve_fieldops_cash_drop_v1() ->> 'expected_sar', '17',
    'cash drop uses the tenant default when no route is assigned');
END;
$fixture$;

SELECT * FROM pg_temp.check_fieldops_lookup_and_cash_policy();
SELECT * FROM finish();
ROLLBACK;
