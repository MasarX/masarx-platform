-- pgTAP: FieldOps Mobile V2 driver signup status contract.
-- Proves duplicate identity readback plus approved, rejected, and
-- additional-documents applicant state
-- through the same canonical marketplace participant request path used by the
-- native Mobile V2 signup bridge.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(26);

DO $$
DECLARE
  v_email_a TEXT := 'fieldops-v2-driver-signup-email-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_b TEXT := 'fieldops-v2-driver-signup-phone-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_c TEXT := 'fieldops-v2-driver-signup-employee-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_d TEXT := 'fieldops-v2-driver-signup-docs-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_e TEXT := 'fieldops-v2-driver-signup-approved-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_f TEXT := 'fieldops-v2-driver-signup-rejected-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_phone_a TEXT := '+966500' || lpad((floor(random() * 999999))::int::text, 6, '0');
  v_phone_b TEXT := '+966501' || lpad((floor(random() * 999999))::int::text, 6, '0');
  v_employee_a TEXT := 'DRV-FOPS-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  v_employee_b TEXT := 'DRV-FOPS-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  v_employee_c TEXT := 'DRV-FOPS-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  v_create_email JSONB;
  v_dup_email JSONB;
  v_create_phone JSONB;
  v_dup_phone JSONB;
  v_create_employee JSONB;
  v_dup_employee JSONB;
  v_docs_create JSONB;
  v_docs_status_before JSONB;
  v_docs_review JSONB;
  v_docs_status_after JSONB;
  v_docs_request UUID;
  v_docs_token UUID;
  v_approve_create JSONB;
  v_approve_status_before JSONB;
  v_approve_review JSONB;
  v_approve_status_after JSONB;
  v_approve_request UUID;
  v_approve_token UUID;
  v_reject_create JSONB;
  v_reject_status_before JSONB;
  v_reject_review JSONB;
  v_reject_status_after JSONB;
  v_reject_request UUID;
  v_reject_token UUID;
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  v_create_email := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_a,
    'FieldOps V2 Email Duplicate',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    v_phone_a,
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', v_employee_a),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-email',
    TRUE
  );

  v_dup_email := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    upper(v_email_a),
    'FieldOps V2 Email Duplicate Retry',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    '+966599000001',
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', 'DRV-FOPS-EMAIL-RETRY'),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-email-retry',
    TRUE
  );

  v_create_phone := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_b,
    'FieldOps V2 Phone Duplicate',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    v_phone_b,
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', v_employee_b),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-phone',
    TRUE
  );

  v_dup_phone := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    'fieldops-v2-driver-signup-phone-retry-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com',
    'FieldOps V2 Phone Duplicate Retry',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    v_phone_b,
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', 'DRV-FOPS-PHONE-RETRY'),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-phone-retry',
    TRUE
  );

  v_create_employee := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_c,
    'FieldOps V2 Employee Duplicate',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    '+966502' || lpad((floor(random() * 999999))::int::text, 6, '0'),
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', '  ' || v_employee_c || '  '),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-employee',
    TRUE
  );

  v_dup_employee := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    'fieldops-v2-driver-signup-employee-retry-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com',
    'FieldOps V2 Employee Duplicate Retry',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    '+966503' || lpad((floor(random() * 999999))::int::text, 6, '0'),
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', lower(v_employee_c)),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-employee-retry',
    TRUE
  );

  v_docs_create := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_d,
    'FieldOps V2 Additional Docs',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    '+966504' || lpad((floor(random() * 999999))::int::text, 6, '0'),
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', 'DRV-FOPS-DOCS-' || left(replace(gen_random_uuid()::text, '-', ''), 8)),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-docs',
    TRUE
  );

  v_docs_request := NULLIF(v_docs_create->>'id', '')::uuid;
  v_docs_token := NULLIF(v_docs_create->>'application_status_token', '')::uuid;
  v_docs_status_before := public.marketplace_application_status_by_token_v1(v_docs_token);
  v_docs_review := public.marketplace_participant_request_review_apply_v1(
    v_docs_request,
    'request_additional_docs',
    NULL,
    NULL,
    FALSE,
    NULL,
    NULL,
    NULL,
    jsonb_build_object(
      'reason', 'mobile_v2_driver_signup_docs_required',
      'requested_documents', jsonb_build_array('driver_license', 'vehicle_registration')
    )
  );
  v_docs_status_after := public.marketplace_application_status_by_token_v1(v_docs_token);

  v_approve_create := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_e,
    'FieldOps V2 Approved Applicant',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    '+966505' || lpad((floor(random() * 999999))::int::text, 6, '0'),
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', 'DRV-FOPS-APPROVED-' || left(replace(gen_random_uuid()::text, '-', ''), 8)),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-approved',
    TRUE
  );

  v_approve_request := NULLIF(v_approve_create->>'id', '')::uuid;
  v_approve_token := NULLIF(v_approve_create->>'application_status_token', '')::uuid;
  v_approve_status_before := public.marketplace_application_status_by_token_v1(v_approve_token);
  v_approve_review := public.marketplace_participant_request_review_apply_v1(
    v_approve_request,
    'approved',
    NULL,
    gen_random_uuid(),
    TRUE,
    'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/onboarding',
    NULL,
    NULL,
    jsonb_build_object('reason', 'mobile_v2_driver_signup_approved')
  );
  v_approve_status_after := public.marketplace_application_status_by_token_v1(v_approve_token);

  v_reject_create := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_f,
    'FieldOps V2 Rejected Applicant',
    'FieldOps Mobile V2 Proof Fleet',
    NULL,
    '+966506' || lpad((floor(random() * 999999))::int::text, 6, '0'),
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    '[]'::jsonb,
    jsonb_build_object('employee_or_contractor_id', 'DRV-FOPS-REJECTED-' || left(replace(gen_random_uuid()::text, '-', ''), 8)),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-rejected',
    TRUE
  );

  v_reject_request := NULLIF(v_reject_create->>'id', '')::uuid;
  v_reject_token := NULLIF(v_reject_create->>'application_status_token', '')::uuid;
  v_reject_status_before := public.marketplace_application_status_by_token_v1(v_reject_token);
  v_reject_review := public.marketplace_participant_request_review_apply_v1(
    v_reject_request,
    'rejected',
    NULL,
    NULL,
    FALSE,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('reason', 'mobile_v2_driver_signup_rejected')
  );
  v_reject_status_after := public.marketplace_application_status_by_token_v1(v_reject_token);

  CREATE TEMP TABLE fieldops_mobile_v2_driver_signup_status_results (
    create_email JSONB,
    dup_email JSONB,
    create_phone JSONB,
    dup_phone JSONB,
    create_employee JSONB,
    dup_employee JSONB,
    docs_create JSONB,
    docs_status_before JSONB,
    docs_review JSONB,
    docs_status_after JSONB,
    approve_create JSONB,
    approve_status_before JSONB,
    approve_review JSONB,
    approve_status_after JSONB,
    reject_create JSONB,
    reject_status_before JSONB,
    reject_review JSONB,
    reject_status_after JSONB
  ) ON COMMIT DROP;

  INSERT INTO fieldops_mobile_v2_driver_signup_status_results
  VALUES (
    v_create_email,
    v_dup_email,
    v_create_phone,
    v_dup_phone,
    v_create_employee,
    v_dup_employee,
    v_docs_create,
    v_docs_status_before,
    v_docs_review,
    v_docs_status_after,
    v_approve_create,
    v_approve_status_before,
    v_approve_review,
    v_approve_status_after,
    v_reject_create,
    v_reject_status_before,
    v_reject_review,
    v_reject_status_after
  );
END $$;

SELECT ok((create_email->>'ok')::boolean, 'Mobile V2 driver signup creates canonical participant request')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(NULLIF(create_email->>'application_status_token', '') IS NOT NULL, 'Mobile V2 driver signup returns browser-safe status token')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok((dup_email->>'deduped')::boolean, 'duplicate email returns existing participant request')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(dup_email->>'dedupe_reason', 'email', 'duplicate email readback explains email match')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(dup_email->>'id', create_email->>'id', 'duplicate email returns the original request id')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok((dup_phone->>'deduped')::boolean, 'duplicate phone returns existing participant request')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(dup_phone->>'dedupe_reason', 'phone', 'duplicate phone readback explains phone match')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(dup_phone->>'id', create_phone->>'id', 'duplicate phone returns the original request id')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok((dup_employee->>'deduped')::boolean, 'duplicate employee or contractor id returns existing participant request')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(dup_employee->>'dedupe_reason', 'employee_or_contractor_id', 'duplicate employee id readback explains employee id match')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(docs_status_before->>'application_state', 'pending_review', 'status token starts as pending review')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  (docs_review->>'ok')::boolean
  AND docs_status_after->>'application_state' = 'additional_documents_requested'
  AND (docs_status_after->'requested_documents') ? 'driver_license'
  AND (docs_status_after->'requested_documents') ? 'vehicle_registration',
  'status token readback exposes additional-documents requested state and document list'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(approve_status_before->>'application_state', 'pending_review', 'approved-applicant status token starts as pending review')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  (approve_review->>'ok')::boolean
  AND approve_status_after->>'status' = 'approved'
  AND approve_status_after->>'application_state' = 'approved'
  AND approve_status_after->>'review_decision' = 'approved'
  AND NULLIF(approve_status_after->>'invite_email_sent_at', '') IS NOT NULL,
  'status token readback exposes approved applicant state and invite email timestamp'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(approve_status_after->>'review_reason', 'mobile_v2_driver_signup_approved', 'approved status token preserves review reason')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  (approve_review->'driver_profile_readback'->>'ok')::boolean
  AND NULLIF(approve_review->'driver_profile_readback'->>'driver_profile_id', '') IS NOT NULL
  AND approve_review->'driver_profile_readback'->>'marketplace_participant_request_id' = approve_create->>'id',
  'approved self-signup request materializes canonical driver profile readback'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_participant_requests r
      JOIN public.driver_profiles dp
        ON dp.organization_id = r.approved_organization_id
       AND dp.user_id = r.approved_user_id
     WHERE r.id = NULLIF(approve_create->>'id', '')::uuid
       AND dp.metadata->>'marketplace_participant_request_id' = r.id::text
  ),
  'approved self-signup driver profile is persisted with participant request lineage'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.marketplace_participant_requests r
      JOIN public.driver_profiles dp
        ON dp.organization_id = r.approved_organization_id
       AND dp.user_id = r.approved_user_id
     WHERE r.id = NULLIF(approve_create->>'id', '')::uuid
       AND dp.driver_code = upper(r.marketing->>'employee_or_contractor_id')
  ),
  'approved self-signup driver profile reuses the mobile employee-or-contractor id as driver code when available'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(reject_status_before->>'application_state', 'pending_review', 'rejected-applicant status token starts as pending review')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  (reject_review->>'ok')::boolean
  AND reject_status_after->>'status' = 'rejected'
  AND reject_status_after->>'application_state' = 'rejected'
  AND reject_status_after->>'review_decision' = 'rejected',
  'status token readback exposes rejected applicant state'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(reject_status_after->>'review_reason', 'mobile_v2_driver_signup_rejected', 'rejected status token preserves review reason')
FROM fieldops_mobile_v2_driver_signup_status_results;

-- F131: only admitted disposable, serialized full-local qualification may run
-- this fixture: the current driver_status default is global, not tenant-scoped.
-- The existing final ROLLBACK removes all fixture mutations after TAP finish().
RESET ROLE;
CREATE TEMP TABLE f131_profile_guard_results (name text PRIMARY KEY, passed boolean) ON COMMIT DROP;
DO $$
DECLARE
  original_request uuid;
  original_profile uuid;
  original_org uuid;
  original_user uuid;
  alternate_status text;
  baseline jsonb;
  result jsonb;
  created jsonb;
  request_id uuid;
  review jsonb;
  new_profile uuid;
  other_org uuid;
  case_name text;
  code text;
  changed_rows integer;
BEGIN
  SELECT r.id, r.approved_organization_id, r.approved_user_id, dp.id, dp.driver_code
    INTO STRICT original_request, original_org, original_user, original_profile, code
    FROM fieldops_mobile_v2_driver_signup_status_results f
    JOIN public.marketplace_participant_requests r ON r.id = (f.approve_create->>'id')::uuid
    JOIN public.driver_profiles dp ON dp.organization_id = r.approved_organization_id
      AND dp.user_id = r.approved_user_id;
  SELECT lv.value INTO alternate_status
    FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'driver_status' AND lv.status = 'active' AND NOT COALESCE(lv.is_default, false)
    ORDER BY lv.sort_order, lv.value LIMIT 1;
  IF alternate_status IS NULL OR code IS NULL THEN
    RAISE EXCEPTION 'F131 fixture prerequisite: alternate configured driver status and owned driver code required';
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Existing-profile reuse must preserve a nondefault status, ID and ownership.
  UPDATE public.driver_profiles SET status = alternate_status WHERE id = original_profile;
  result := public.marketplace_driver_profile_from_participant_request_v1(original_request);
  INSERT INTO f131_profile_guard_results VALUES ('reuse',
    result->>'ok' = 'true' AND result->>'created' = 'false'
    AND result->>'driver_profile_id' = original_profile::text
    AND result->>'status' = alternate_status
    AND (SELECT count(*) = 1 FROM public.driver_profiles WHERE organization_id = original_org AND user_id = original_user)
    AND (SELECT status = alternate_status AND metadata->>'marketplace_participant_request_id' = original_request::text
      FROM public.driver_profiles WHERE id = original_profile));
  FOREACH case_name IN ARRAY ARRAY['configured_default', 'collision', 'missing_default'] LOOP
    created := public.marketplace_participant_request_create_v1(
      'freelancer_driver', 'f131-' || gen_random_uuid()::text || '@example.com',
      'F131 owned profile guard', 'F131 owned fleet', NULL, NULL, NULL, 'en',
      'fieldops-mobile-v2-native://signup', NULL, 'fieldops-mobile-v2-native://signup', NULL,
      jsonb_build_array('last_mile_driver'), '[]'::jsonb,
      jsonb_build_object('employee_or_contractor_id', 'F131-' || gen_random_uuid()::text),
      jsonb_build_object('source', 'f131_profile_guard'), NULL, NULL,
      'f131-' || gen_random_uuid()::text, TRUE);
    request_id := NULLIF(created->>'id', '')::uuid;
    IF created->>'ok' IS DISTINCT FROM 'true' OR request_id IS NULL OR COALESCE((created->>'deduped')::boolean, false) THEN
      RAISE EXCEPTION 'F131 owned request setup failed: %', case_name;
    END IF;
    IF case_name = 'collision' THEN
      -- Mutate only the freshly owned pending fixture after intake dedupe; the
      -- selected profile bridge must handle a code occupied before approval.
      UPDATE public.marketplace_participant_requests
        SET marketing = jsonb_set(COALESCE(marketing, '{}'::jsonb), '{employee_or_contractor_id}', to_jsonb(code))
        WHERE id = request_id AND status = 'pending';
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
      IF changed_rows <> 1 OR NOT EXISTS (SELECT 1 FROM public.marketplace_participant_requests
        WHERE id = request_id AND status = 'pending' AND marketing->>'employee_or_contractor_id' = code) THEN
        RAISE EXCEPTION 'F131 collision setup did not update exactly the owned pending request';
      END IF;
      -- Review below must consume this verified collision, not a missing fixture value.
    END IF;
    UPDATE public.lookup_values lv SET is_default =
      (case_name <> 'missing_default' AND lv.value = alternate_status)
      FROM public.lookup_definitions ld
      WHERE ld.id = lv.lookup_definition_id AND ld.category = 'driver_status';
    SELECT jsonb_agg(to_jsonb(dp) ORDER BY dp.id) INTO baseline FROM public.driver_profiles dp;
    review := public.marketplace_participant_request_review_apply_v1(
      request_id, 'approved', NULL, gen_random_uuid(), TRUE,
      'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/onboarding',
      CASE WHEN case_name = 'configured_default' THEN NULL ELSE original_org END,
      NULL, jsonb_build_object('reason', 'f131_profile_guard'));
    new_profile := NULLIF(review#>>'{driver_profile_readback,driver_profile_id}', '')::uuid;
    IF case_name = 'missing_default' THEN
      INSERT INTO f131_profile_guard_results VALUES (case_name,
        review->>'ok' = 'false'
        AND review#>>'{driver_profile_readback,error,code}' = 'driver_status_default_missing'
        AND baseline IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(dp) ORDER BY dp.id) FROM public.driver_profiles dp));
    ELSE
      INSERT INTO f131_profile_guard_results VALUES (case_name,
        review->>'ok' = 'true' AND new_profile IS NOT NULL AND new_profile <> original_profile
        AND EXISTS (SELECT 1 FROM public.driver_profiles dp JOIN public.marketplace_participant_requests r
          ON r.id = request_id AND dp.organization_id = r.approved_organization_id AND dp.user_id = r.approved_user_id
          WHERE dp.id = new_profile AND dp.status = alternate_status
            AND dp.metadata->>'marketplace_participant_request_id' = request_id::text
            AND (case_name <> 'collision' OR dp.driver_code IS NULL))
        AND (SELECT count(*) = 1 FROM public.driver_profiles dp JOIN public.marketplace_participant_requests r
          ON r.id = request_id AND dp.organization_id = r.approved_organization_id AND dp.user_id = r.approved_user_id)
        AND (case_name <> 'collision' OR EXISTS (SELECT 1 FROM public.driver_profiles
          WHERE id = original_profile AND user_id = original_user AND organization_id = original_org AND driver_code = code)));
      IF case_name = 'configured_default' THEN
        SELECT approved_organization_id INTO other_org FROM public.marketplace_participant_requests WHERE id = request_id;
      END IF;
    END IF;
  END LOOP;
  IF other_org IS NULL OR other_org = original_org THEN
    RAISE EXCEPTION 'F131 fixture prerequisite: independently created owned organization required';
  END IF;
  SELECT jsonb_agg(to_jsonb(dp) ORDER BY dp.id) INTO baseline FROM public.driver_profiles dp;
  UPDATE public.marketplace_participant_requests SET approved_organization_id = other_org WHERE id = original_request;
  result := public.marketplace_driver_profile_from_participant_request_v1(original_request);
  INSERT INTO f131_profile_guard_results VALUES ('foreign_user',
    result#>>'{error,code}' = 'approved_user_org_mismatch' AND result->>'ok' = 'false'
    AND baseline IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(dp) ORDER BY dp.id) FROM public.driver_profiles dp));
END $$;
SELECT ok(passed, 'F131 profile bridge preserves ' || name) FROM f131_profile_guard_results ORDER BY name;

SELECT * FROM finish();
ROLLBACK;
