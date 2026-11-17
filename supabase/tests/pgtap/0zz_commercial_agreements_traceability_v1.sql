-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Commercial agreements traceability (RLS + constraints)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

CREATE OR REPLACE FUNCTION test_commercial_agreements_traceability_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := gen_random_uuid();
  v_org2 UUID := gen_random_uuid();
  v_user1 UUID := gen_random_uuid();
  v_user2 UUID := gen_random_uuid();
  v_client2 UUID := gen_random_uuid();
  v_sender2 UUID := gen_random_uuid();
  v_ag1 UUID := gen_random_uuid();
  v_ag2 UUID := gen_random_uuid();
  v_settings_ok UUID := gen_random_uuid();
  v_settings_unapproved UUID := gen_random_uuid();
  v_nil UUID := '00000000-0000-0000-0000-000000000000'::uuid;

  v_perm_agreements_read UUID;
  v_role_agreements1 UUID;
  v_role_agreements2 UUID;
BEGIN
  RETURN NEXT has_table('public', 'commercial_agreements', 'commercial_agreements table exists');
  RETURN NEXT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'commercial_agreements'),
    'RLS enabled on commercial_agreements'
  );
  RETURN NEXT ok(
    EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'commercial_agreements'),
    'commercial_agreements has policies'
  );

  RETURN NEXT has_table('public', 'commercial_agreement_terms', 'commercial_agreement_terms table exists');
  RETURN NEXT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'commercial_agreement_terms'),
    'RLS enabled on commercial_agreement_terms'
  );
  RETURN NEXT ok(
    EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'commercial_agreement_terms'),
    'commercial_agreement_terms has policies'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'Agreements Org 1', 'agreements-org-' || left(v_org1::text, 8)),
    (v_org2, 'Agreements Org 2', 'agreements-org-' || left(v_org2::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name)
  VALUES
    (v_user1, v_org1, 'ag-u1-' || left(v_user1::text, 8) || '@example.com', 'Agreements User 1'),
    (v_user2, v_org2, 'ag-u2-' || left(v_user2::text, 8) || '@example.com', 'Agreements User 2');

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client2, v_org2, 'Agreements Client 2', 'ag-client-' || left(v_client2::text, 8));

  INSERT INTO public.senders (id, client_id, name)
  VALUES (v_sender2, v_client2, 'Agreements Sender 2');

  INSERT INTO public.commercial_agreements (id, organization_id, agreement_code, title, status)
  VALUES
    (v_ag1, v_org1, 'agreement-' || left(v_ag1::text, 8), 'Agreement 1', 'active'),
    (v_ag2, v_org2, 'agreement-' || left(v_ag2::text, 8), 'Agreement 2', 'active');

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, version, value, approved_at, effective_from, effective_until
  )
  VALUES
    (v_settings_ok, 'pricing_policy', 'global', NULL, 1, '{}'::jsonb, now(), now(), now() + interval '1 day'),
    (v_settings_unapproved, 'pricing_policy', 'global', NULL, 2, '{}'::jsonb, NULL, now(), now() + interval '1 day');

  INSERT INTO public.commercial_agreement_terms (agreement_id, category, settings_version_id, settings_scope_hash)
  VALUES
    (v_ag1, 'pricing_policy', v_settings_ok, v_nil),
    (v_ag2, 'pricing_policy', v_settings_ok, v_nil);

  SELECT lv.id
    INTO v_perm_agreements_read
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'agreements.read'
   LIMIT 1;

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.commercial_agreements (organization_id, client_id, status)
         VALUES (%L, %L, 'active') $q$,
      v_org1,
      v_client2
    ),
    '23514',
    format('commercial_agreements: organization mismatch (agreement org %s, client org %s)', v_org1, v_org2)
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.commercial_agreements (organization_id, sender_id, status)
         VALUES (%L, %L, 'active') $q$,
      v_org1,
      v_sender2
    ),
    '23514',
    format('commercial_agreements: organization mismatch (agreement org %s, sender org %s)', v_org1, v_org2)
  );

  EXECUTE 'SET CONSTRAINTS trg_commercial_agreement_terms_validate_ref IMMEDIATE';

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.commercial_agreement_terms (agreement_id, category, settings_version_id, settings_scope_hash)
         VALUES (%L, 'shipment_promise_policy', %L, %L) $q$,
      v_ag1,
      v_settings_ok,
      v_nil
    ),
    '23514',
    'commercial_agreement_terms: category mismatch (term shipment_promise_policy, settings_versions pricing_policy)'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ UPDATE public.commercial_agreement_terms
          SET settings_version_id = %L
        WHERE agreement_id = %L
          AND category = 'pricing_policy' $q$,
      v_settings_unapproved,
      v_ag1
    ),
    '23514',
    format('commercial_agreement_terms: settings_version %s is not approved', v_settings_unapproved)
  );

  -- user1 (tenant scope, org1)
  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreements WHERE id = v_ag1), 0, 'user1 without agreements.read cannot see own agreement');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreement_terms WHERE agreement_id = v_ag1), 0, 'user1 without agreements.read cannot see own agreement terms');

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.rbac_roles (organization_id, key, name, metadata)
  VALUES (v_org1, 'agreements', 'Agreements', jsonb_build_object('source', 'pgtap'))
  RETURNING id INTO v_role_agreements1;

  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  VALUES (v_org1, v_role_agreements1, v_perm_agreements_read, jsonb_build_object('source', 'pgtap'));

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, metadata)
  VALUES (v_org1, v_user1, v_role_agreements1, jsonb_build_object('source', 'pgtap'));

  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreements WHERE id = v_ag1), 1, 'user1 sees own agreement');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreements WHERE id = v_ag2), 0, 'user1 cannot see other org agreement');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreement_terms WHERE agreement_id = v_ag1), 1, 'user1 sees own agreement terms');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreement_terms WHERE agreement_id = v_ag2), 0, 'user1 cannot see other org agreement terms');

  RETURN NEXT throws_ok(
    format($q$ INSERT INTO public.commercial_agreements (organization_id, status) VALUES (%L, 'active') $q$, v_org1),
    '42501',
    'permission denied for table commercial_agreements'
  );

  RETURN NEXT throws_ok(
    format(
      $q$ INSERT INTO public.commercial_agreement_terms (agreement_id, category, settings_version_id, settings_scope_hash)
         VALUES (%L, 'pricing_policy', %L, %L) $q$,
      v_ag1,
      v_settings_ok,
      v_nil
    ),
    '42501',
    'permission denied for table commercial_agreement_terms'
  );

  -- user2 (tenant scope, org2)
  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreements WHERE id = v_ag2), 0, 'user2 without agreements.read cannot see own agreement');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreement_terms WHERE agreement_id = v_ag2), 0, 'user2 without agreements.read cannot see own agreement terms');

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.rbac_roles (organization_id, key, name, metadata)
  VALUES (v_org2, 'agreements', 'Agreements', jsonb_build_object('source', 'pgtap'))
  RETURNING id INTO v_role_agreements2;

  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  VALUES (v_org2, v_role_agreements2, v_perm_agreements_read, jsonb_build_object('source', 'pgtap'));

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, metadata)
  VALUES (v_org2, v_user2, v_role_agreements2, jsonb_build_object('source', 'pgtap'));

  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreements WHERE id = v_ag2), 1, 'user2 sees own agreement');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreements WHERE id = v_ag1), 0, 'user2 cannot see other org agreement');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreement_terms WHERE agreement_id = v_ag2), 1, 'user2 sees own agreement terms');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.commercial_agreement_terms WHERE agreement_id = v_ag1), 0, 'user2 cannot see other org agreement terms');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN;
END;
$function$;

SELECT * FROM test_commercial_agreements_traceability_v1();

SELECT * FROM finish();

ROLLBACK;
