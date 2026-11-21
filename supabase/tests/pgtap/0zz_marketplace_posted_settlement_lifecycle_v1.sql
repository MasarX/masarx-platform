-- pgTAP: marketplace posted settlement helper follows canonical lifecycle
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

SELECT has_function(
  'public',
  'marketplace_create_posted_settlement_batch_v1',
  ARRAY['uuid', 'text', 'uuid', 'uuid', 'timestamp with time zone', 'jsonb', 'text']::name[],
  'marketplace_create_posted_settlement_batch_v1 exists'
);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-0000000f0606';
  v_contract UUID := '00000000-0000-4000-8000-0000000f0606';
  v_partner UUID := '00000000-0000-4000-8000-0000000f0607';
  v_finance_event UUID;
  v_batch UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Marketplace settlement proof org', 'marketplace-settlement-proof-org')
  ON CONFLICT (id) DO NOTHING;

  SELECT finance_event_id
    INTO v_finance_event
    FROM public.record_finance_event_v1(jsonb_build_object(
      'organization_id', v_org,
      'event_type', 'payout',
      'direction', 'out',
      'amount', 321.45,
      'currency', 'SAR',
      'account_type', 'external',
      'account_id', v_partner,
      'subject_type', 'marketplace_contract',
      'subject_id', v_contract,
      'idempotency_key', 'pgtap-marketplace-posted-settlement-finance-event',
      'metadata', jsonb_build_object(
        'event', 'remit',
        'partner_id', v_partner::text,
        'source', '0zz_marketplace_posted_settlement_lifecycle_v1'
      )
    ))
   LIMIT 1;

  SELECT public.marketplace_create_posted_settlement_batch_v1(
      v_org,
      'payout',
      v_contract,
      v_finance_event,
      now(),
      jsonb_build_object(
        'source', '0zz_marketplace_posted_settlement_lifecycle_v1',
        'partner_id', v_partner::text,
        'participant_id', v_partner::text,
        'supplier_participant_profile_id', v_partner::text,
        'expected_amount', 321.45,
        'collected_amount', 321.45,
        'remitted_amount', 321.45
      ),
      'pgtap-marketplace-posted-settlement-batch'
    )
    INTO v_batch;

  PERFORM set_config('test.marketplace_settlement_batch_id', v_batch::text, true);
  PERFORM set_config('test.marketplace_settlement_finance_event_id', v_finance_event::text, true);
  PERFORM set_config('test.marketplace_settlement_partner_id', v_partner::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT status FROM public.settlement_batches WHERE id = current_setting('test.marketplace_settlement_batch_id')::uuid),
  'posted',
  'marketplace helper leaves the settlement batch posted'
);

SELECT results_eq(
  $$
    SELECT from_status, to_status
      FROM public.settlement_events
     WHERE settlement_batch_id = current_setting('test.marketplace_settlement_batch_id')::uuid
       AND event_type = 'status_changed'
     ORDER BY batch_version
  $$,
  $$
    VALUES ('open'::text, 'locked'::text),
           ('locked'::text, 'approved'::text),
           ('approved'::text, 'posted'::text)
  $$,
  'marketplace helper transitions open -> locked -> approved -> posted'
);

SELECT is(
  (SELECT remitted_amount::text
     FROM public.v_settlement_batch_summary
    WHERE id = current_setting('test.marketplace_settlement_batch_id')::uuid),
  '321.45',
  'settlement summary exposes remitted payout amount'
);

SELECT is(
  (SELECT supplier_participant_profile_id
     FROM public.v_settlement_batch_summary
    WHERE id = current_setting('test.marketplace_settlement_batch_id')::uuid),
  current_setting('test.marketplace_settlement_partner_id'),
  'settlement summary preserves partner profile lineage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settlement_batch_finance_events sbfe
     WHERE sbfe.settlement_batch_id = current_setting('test.marketplace_settlement_batch_id')::uuid
       AND sbfe.finance_event_id = current_setting('test.marketplace_settlement_finance_event_id')::uuid
  ),
  'settlement batch is linked to the finance event membership table'
);

CREATE FUNCTION pg_temp.test_marketplace_finalize_after_reversal()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
DECLARE
  v_requester uuid := gen_random_uuid();
  v_supplier uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_platform_org uuid := gen_random_uuid();
  v_platform_actor uuid := gen_random_uuid();
  v_profile uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_offer uuid := gen_random_uuid();
  v_award uuid := gen_random_uuid();
  v_contract uuid := gen_random_uuid();
  v_work_package uuid := gen_random_uuid();
  v_result jsonb;
  v_reversal_rejection CONSTANT jsonb := '{"ok":false,"error":{"code":"settlement_already_reversed"}}'::jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_requester, 'Reversal fixture requester', 'reversal-requester-' || left(v_requester::text, 8)),
    (v_supplier, 'Reversal fixture supplier', 'reversal-supplier-' || left(v_supplier::text, 8)),
    (v_platform_org, 'Reversal fixture platform', 'reversal-platform-' || left(v_platform_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_actor, v_requester, 'reversal-' || v_actor::text || '@example.com', 'Reversal fixture operator', 'ops_admin', 'tenant'),
    (v_platform_actor, v_platform_org, 'reversal-' || v_platform_actor::text || '@example.com', 'Reversal fixture platform operator', 'super_admin', 'platform');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_requester, ARRAY['ops_admin'], v_actor);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id)
  SELECT v_requester, v_actor, id, v_actor
    FROM public.rbac_roles
   WHERE organization_id = v_requester AND key = 'ops_admin';

  INSERT INTO public.marketplace_participant_profiles (id, organization_id, participant_type_key, display_name)
  VALUES (v_profile, v_supplier, 'freelancer_driver', 'Reversal fixture supplier');
  INSERT INTO public.marketplace_requests (id, requester_organization_id, request_kind_key, title, status)
  VALUES (v_request, v_requester, 'capacity_block', 'Reversal fixture request', 'completed');
  INSERT INTO public.marketplace_offers (
    id, request_id, supplier_participant_profile_id, supplier_organization_id, pricing
  )
  VALUES (v_offer, v_request, v_profile, v_supplier, '{"amount":91,"currency":"SAR"}');
  INSERT INTO public.marketplace_awards (
    id, request_id, offer_id, requester_organization_id, supplier_organization_id, supplier_participant_profile_id
  )
  VALUES (v_award, v_request, v_offer, v_requester, v_supplier, v_profile);
  INSERT INTO public.marketplace_contracts (
    id, request_id, award_id, requester_organization_id, supplier_organization_id,
    supplier_participant_profile_id, status, settlement_mode_key
  )
  VALUES (v_contract, v_request, v_award, v_requester, v_supplier, v_profile, 'completed', 'auto_recorded_internal');
  INSERT INTO public.marketplace_work_packages (
    id, contract_id, request_id, award_id, requester_organization_id,
    supplier_organization_id, supplier_participant_profile_id, status
  )
  VALUES (v_work_package, v_contract, v_request, v_award, v_requester, v_supplier, v_profile, 'completed');

  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  v_result := public.marketplace_settlement_finalize_v1(v_work_package, v_contract);
  IF v_result->>'status' IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'marketplace fixture did not finalize: %', v_result;
  END IF;
  v_result := public.marketplace_settlement_reverse_v1(v_work_package, 'Synthetic reversal');
  IF v_result->>'status' IS DISTINCT FROM 'completed' OR v_result->>'requester_settlement_batch_id' IS NULL THEN
    RAISE EXCEPTION 'marketplace fixture did not reverse: %', v_result;
  END IF;

  RETURN NEXT is(
    public.marketplace_settlement_finalize_v1(v_work_package, v_contract),
    v_reversal_rejection,
    'a posted reversal prevents re-finalizing the marketplace work package'
  );
  RESET ROLE;

  RETURN NEXT is(
    public.marketplace_post_completed_settlement_v1(v_work_package, '{}'::jsonb),
    v_reversal_rejection,
    'the shared posting helper rejects a posted reversal before settlement'
  );

  -- Completion normally short-circuits after reversal. Reopen the rollback
  -- fixture with the posted reversal intact to exercise the platform posting path.
  UPDATE public.marketplace_work_packages
     SET status = 'in_execution'
   WHERE id = v_work_package;

  PERFORM set_config('request.jwt.claim.sub', v_platform_actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_platform_actor, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_result := api.marketplace_work_package_complete_v1(v_work_package);
  RETURN NEXT is(
    v_result->'settlement',
    v_reversal_rejection,
    'authorized non-party platform completion cannot re-post a reversed settlement'
  );
  RESET ROLE;
END;
$function$;

SELECT * FROM pg_temp.test_marketplace_finalize_after_reversal();

SELECT * FROM finish();
ROLLBACK;
