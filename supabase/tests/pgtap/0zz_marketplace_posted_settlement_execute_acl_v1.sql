BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SET LOCAL statement_timeout = '30s';
SELECT plan(9);

-- Mutation: restoring PUBLIC EXECUTE or granting EXECUTE to anon fails this check.
SELECT ok(NOT has_function_privilege('anon',
  'public.marketplace_create_posted_settlement_batch_v1(uuid,text,uuid,uuid,timestamptz,jsonb,text)', 'EXECUTE'),
  'anon cannot execute the posted settlement batch helper');
-- Mutation: granting EXECUTE to authenticated fails this check.
SELECT ok(NOT has_function_privilege('authenticated',
  'public.marketplace_create_posted_settlement_batch_v1(uuid,text,uuid,uuid,timestamptz,jsonb,text)', 'EXECUTE'),
  'authenticated cannot execute the posted settlement batch helper');
-- Mutation: revoking the service role grant fails this check.
SELECT ok(has_function_privilege('service_role',
  'public.marketplace_create_posted_settlement_batch_v1(uuid,text,uuid,uuid,timestamptz,jsonb,text)', 'EXECUTE'),
  'service_role can execute the posted settlement batch helper');

SET LOCAL ROLE authenticated;
-- Mutation: restoring EXECUTE enters the function body and loses this exact ACL error.
SELECT throws_ok(
  $$SELECT public.marketplace_create_posted_settlement_batch_v1(
    NULL::uuid, NULL::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::jsonb, NULL::text)$$,
  '42501', 'permission denied for function marketplace_create_posted_settlement_batch_v1',
  'authenticated is denied at the posted settlement batch function ACL'
);
RESET ROLE;

DO $$
DECLARE
  v_requester uuid := gen_random_uuid();
  v_supplier uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_party_user uuid := gen_random_uuid();
  v_outside_user uuid := gen_random_uuid();
  v_profile uuid;
  v_request uuid;
  v_offer uuid;
  v_award uuid;
  v_contract uuid;
  v_work_package uuid;
BEGIN
  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES
    (v_requester, 'Settlement Requester', 'settlement-requester-' || v_requester::text, 'active'),
    (v_supplier, 'Settlement Supplier', 'settlement-supplier-' || v_supplier::text, 'active'),
    (v_outsider, 'Settlement Non-Party', 'settlement-non-party-' || v_outsider::text, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_party_user, v_requester, v_party_user::text || '@example.test', 'Settlement Party', 'ops_admin', 'active', 'tenant'),
    (v_outside_user, v_outsider, v_outside_user::text || '@example.test', 'Settlement Non-Party', 'ops_admin', 'active', 'tenant');

  INSERT INTO public.marketplace_participant_profiles (organization_id, participant_type_key, display_name)
  VALUES (v_supplier, 'provider_tenant', 'Settlement Supplier')
  RETURNING id INTO v_profile;

  INSERT INTO public.marketplace_requests (requester_organization_id, request_kind_key, status, title)
  VALUES (v_requester, 'capacity_block', 'completed', 'Settlement Auth Test')
  RETURNING id INTO v_request;

  INSERT INTO public.marketplace_offers (
    request_id, supplier_participant_profile_id, supplier_organization_id, status, pricing
  ) VALUES (v_request, v_profile, v_supplier, 'accepted', '{"amount":100,"currency":"SAR"}')
  RETURNING id INTO v_offer;

  INSERT INTO public.marketplace_awards (
    request_id, offer_id, requester_organization_id, supplier_organization_id, supplier_participant_profile_id, status
  ) VALUES (v_request, v_offer, v_requester, v_supplier, v_profile, 'materialized')
  RETURNING id INTO v_award;

  INSERT INTO public.marketplace_contracts (
    award_id, request_id, requester_organization_id, supplier_organization_id, supplier_participant_profile_id,
    status, settlement_mode_key
  ) VALUES (v_award, v_request, v_requester, v_supplier, v_profile, 'completed', 'auto_recorded_internal')
  RETURNING id INTO v_contract;

  INSERT INTO public.marketplace_work_packages (
    contract_id, award_id, request_id, requester_organization_id, supplier_organization_id,
    supplier_participant_profile_id, status
  ) VALUES (v_contract, v_award, v_request, v_requester, v_supplier, v_profile, 'completed')
  RETURNING id INTO v_work_package;

  PERFORM set_config('test.settlement_acl.party', v_party_user::text, true);
  PERFORM set_config('test.settlement_acl.outsider', v_outside_user::text, true);
  PERFORM set_config('test.settlement_acl.contract', v_contract::text, true);
  PERFORM set_config('test.settlement_acl.work_package', v_work_package::text, true);
END;
$$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.settlement_acl.outsider'), true),
       set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.settlement_acl.outsider'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- Mutation: restoring the old authorization path returns work_package_not_found instead.
SELECT throws_ok(
  $$SELECT api.marketplace_settlement_finalize_v1(
    p_work_package_id := current_setting('test.settlement_acl.work_package')::uuid)$$,
  '42501', 'settlement contract access denied', 'a non-party cannot finalize by work package');

-- Mutation: bypassing the contract-party check admits this caller or returns a domain result.
SELECT throws_ok(
  $$SELECT api.marketplace_settlement_finalize_v1(
    p_contract_id := current_setting('test.settlement_acl.contract')::uuid)$$,
  '42501', 'settlement contract access denied', 'a non-party cannot finalize by contract');

-- Mutation: restoring the old authorization path returns work_package_not_found instead.
SELECT throws_ok(
  $$SELECT api.marketplace_settlement_reverse_v1(current_setting('test.settlement_acl.work_package')::uuid)$$,
  '42501', 'settlement contract access denied', 'a non-party cannot reverse a settlement');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.settlement_acl.party'), true),
       set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.settlement_acl.party'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- Mutation: revoking authenticated access to the entry point prevents legitimate posting.
SELECT is(
  api.marketplace_settlement_finalize_v1(p_contract_id := current_setting('test.settlement_acl.contract')::uuid)->>'status',
  'settled', 'a contract party can finalize through the API');

-- Mutation: revoking authenticated access to the entry point prevents legitimate reversal.
SELECT is(
  api.marketplace_settlement_reverse_v1(current_setting('test.settlement_acl.work_package')::uuid, 'Test reversal')->>'status',
  'completed', 'a contract party can reverse through the API');
RESET ROLE;

SELECT finish();
ROLLBACK;
