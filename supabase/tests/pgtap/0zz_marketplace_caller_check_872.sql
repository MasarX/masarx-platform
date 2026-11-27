BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

SELECT plan(8);

CREATE FUNCTION pg_temp.test_marketplace_caller_check_872()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  requester_org uuid := gen_random_uuid();
  supplier_org uuid := gen_random_uuid();
  requester_user uuid := gen_random_uuid();
  supplier_user uuid := gen_random_uuid();
  reviewer_user uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid();
  application_id uuid := gen_random_uuid();
  supplier_profile uuid := gen_random_uuid();
  expected_match jsonb := jsonb_build_array(jsonb_build_object(
    'participant_profile_id', supplier_profile, 'private_pool_match', true));
BEGIN
  INSERT INTO public.organizations (id, name, slug, billing_status)
  SELECT id, 'Marketplace read fixture', 'pgt-marketplace-' || id, 'active'
  FROM (VALUES (requester_org), (supplier_org)) AS fixture(id);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  SELECT id, org, id || '@example.test', 'Marketplace read fixture', 'ops_admin', 'active', scope_type
  FROM (VALUES (requester_user, requester_org, 'tenant'), (supplier_user, supplier_org, 'tenant'),
               (reviewer_user, supplier_org, 'platform')) AS actor(id, org, scope_type);

  INSERT INTO public.marketplace_participant_profiles (
    id, organization_id, participant_type_key, status, listing_status, compliance_state, display_name
  )
  SELECT supplier_profile, supplier_org, participant_type_supply_key,
         'approved', 'private', 'approved', 'Marketplace supplier fixture'
  FROM public.marketplace_request_kinds WHERE kind_key = 'shipment_batch';

  INSERT INTO public.marketplace_requests (
    id, requester_organization_id, request_kind_key, status, release_state, title, private_pool
  ) VALUES (
    request_id, requester_org, 'shipment_batch', 'published', 'private_pool',
    'Marketplace request fixture', jsonb_build_array(supplier_org)
  );

  INSERT INTO public.marketplace_participant_requests (
    id, requested_organization_id, requested_participant_type_key, email, full_name, organization_name
  ) VALUES (
    application_id, requester_org, 'freelancer_driver', application_id || '@example.test',
    'Marketplace applicant fixture', 'Marketplace read fixture'
  );

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', supplier_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', supplier_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  RETURN NEXT throws_ok(format('SELECT api.marketplace_matching_suggestions_v1(%L)', request_id),
    '42501', NULL, 'matching suggestions require the requester organization for a visible request');
  RETURN NEXT throws_ok(format('SELECT api.marketplace_application_status_v1(%L)', application_id),
    '42501', NULL, 'application status requires the applying organization or reviewer');

  PERFORM set_config('request.jwt.claim.sub', requester_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', requester_user, 'role', 'authenticated')::text, true);
  RETURN NEXT ok(api.marketplace_matching_suggestions_v1(request_id, 1)->'matches' @> expected_match,
    'requester receives the private pool match');
  RETURN NEXT is(api.marketplace_application_status_v1(application_id)->>'id', application_id::text,
    'applying organization receives its application status');

  PERFORM set_config('request.jwt.claim.sub', reviewer_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', reviewer_user, 'role', 'authenticated')::text, true);
  RETURN NEXT is(api.marketplace_application_status_v1(application_id)->>'id', application_id::text,
    'authorized reviewer receives the application status');
  RETURN NEXT throws_ok(format('SELECT api.marketplace_matching_suggestions_v1(%L)', request_id),
    '42501', NULL, 'matching suggestions require requester ownership for reviewers');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SET LOCAL ROLE service_role;
  RETURN NEXT ok(api.marketplace_matching_suggestions_v1(request_id, 1)->'matches' @> expected_match,
    'service role receives the requested marketplace match');
  RETURN NEXT is(api.marketplace_application_status_v1(application_id)->>'id', application_id::text,
    'service role receives the requested application status');
  RESET ROLE;
END;
$test$;

SELECT * FROM pg_temp.test_marketplace_caller_check_872();
SELECT * FROM finish();
ROLLBACK;
