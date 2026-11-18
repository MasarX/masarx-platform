-- Plan: PHASE B / B2 — pgTAP for verify_driver_document_v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION test_verify_driver_document_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb09000-0000-0000-0000-000000000001'::uuid;
  v_admin1 UUID := '0fb09000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb09000-0000-0000-0000-000000000402'::uuid;
  v_driver_user1 UUID := '0fb09000-0000-0000-0000-000000000501'::uuid;
  v_doc1 UUID := '0fb09000-0000-0000-0000-000000000801'::uuid;
  v_doc2 UUID := '0fb09000-0000-0000-0000-000000000802'::uuid;
  v_result JSONB;
BEGIN
  RETURN NEXT has_function('public', 'verify_driver_document_v1', ARRAY['jsonb'],
                           'verify_driver_document_v1(JSONB) exists');

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'Verify Org', 'verify-' || left(v_org1::text, 8));
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'verify-a1@example.com', 'Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'verify-u1@example.com', 'Unpriv', 'client_admin', 'tenant'),
    (v_driver_user1, v_org1, 'verify-d1@example.com', 'Driver', 'driver', 'tenant');
  INSERT INTO public.driver_documents (id, organization_id, user_id, doc_type, status)
  VALUES
    (v_doc1, v_org1, v_driver_user1, 'driver_license', 'submitted'),
    (v_doc2, v_org1, v_driver_user1, 'national_id',   'verified');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['fleet_manager'], v_admin1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_admin1, r.id, v_admin1, jsonb_build_object('seed', TRUE)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org1 AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  -- 1) Denied
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_unpriv1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.verify_driver_document_v1(jsonb_build_object('driver_document_id', %L)) $q$, v_doc1),
    '42501', NULL, 'unprivileged user denied'
  );

  -- 2) Cannot re-verify already-verified document
  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.verify_driver_document_v1(jsonb_build_object('driver_document_id', %L)) $q$, v_doc2),
    '22023', NULL, 'already-verified document not re-verifiable'
  );

  -- 3) Happy path
  v_result := public.verify_driver_document_v1(jsonb_build_object('driver_document_id', v_doc1, 'notes', 'license_clean_no_endorsements'));
  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'returns ok=TRUE');
  RETURN NEXT is(
    (SELECT status FROM public.driver_documents WHERE id = v_doc1),
    'verified',
    'document status flipped to verified'
  );
  RETURN NEXT is(
    (SELECT verified_by_user_id FROM public.driver_documents WHERE id = v_doc1),
    v_admin1,
    'verified_by_user_id stamped to caller'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.driver_compliance_events
       WHERE user_id = v_driver_user1
         AND event_type = 'document_verified'
         AND payload->>'driver_document_id' = v_doc1::text
    ),
    'driver_compliance_events row appended (document_verified)'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_verify_driver_document_v1();
SELECT * FROM finish();
ROLLBACK;
