-- pgTAP: FieldOps Mobile V2 driver signup status contract.
-- Proves duplicate identity readback and additional-documents applicant state
-- through the same canonical marketplace participant request path used by the
-- native Mobile V2 signup bridge.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

DO $$
DECLARE
  v_email_a TEXT := 'fieldops-v2-driver-signup-email-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_b TEXT := 'fieldops-v2-driver-signup-phone-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_c TEXT := 'fieldops-v2-driver-signup-employee-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_d TEXT := 'fieldops-v2-driver-signup-docs-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_e TEXT := 'fieldops-v2-driver-signup-approved-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_f TEXT := 'fieldops-v2-driver-signup-reject-dup-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
  v_email_g TEXT := 'fieldops-v2-driver-signup-reject-compliance-' || left(replace(gen_random_uuid()::text, '-', ''), 12) || '@example.com';
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
  v_approved_create JSONB;
  v_approved_review JSONB;
  v_approved_status JSONB;
  v_approved_request UUID;
  v_approved_token UUID;
  v_approved_auth_user UUID := gen_random_uuid();
  v_rejected_dup_create JSONB;
  v_rejected_dup_review JSONB;
  v_rejected_dup_status JSONB;
  v_rejected_dup_request UUID;
  v_rejected_dup_token UUID;
  v_rejected_compliance_create JSONB;
  v_rejected_compliance_review JSONB;
  v_rejected_compliance_status JSONB;
  v_rejected_compliance_request UUID;
  v_rejected_compliance_token UUID;
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

  v_approved_create := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_e,
    'FieldOps V2 Approved Handoff',
    'FieldOps Mobile V2 Approved Fleet',
    NULL,
    '+966505' || lpad((floor(random() * 999999))::int::text, 6, '0'),
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    jsonb_build_array(
      jsonb_build_object(
        'document_type_key', 'driver_license',
        'document_ref', 'DL-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
        'status', 'approved'
      )
    ),
    jsonb_build_object('employee_or_contractor_id', 'DRV-FOPS-APPROVED-' || left(replace(gen_random_uuid()::text, '-', ''), 8)),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-approved',
    TRUE
  );
  v_approved_request := NULLIF(v_approved_create->>'id', '')::uuid;
  v_approved_token := NULLIF(v_approved_create->>'application_status_token', '')::uuid;
  v_approved_review := public.marketplace_participant_request_review_apply_v1(
    v_approved_request,
    'approve',
    NULL,
    v_approved_auth_user,
    TRUE,
    'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
    NULL,
    NULL,
    jsonb_build_object('reason', 'mobile_v2_driver_signup_approved_handoff')
  );
  v_approved_status := public.marketplace_application_status_by_token_v1(v_approved_token);

  v_rejected_dup_create := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_f,
    'FieldOps V2 Duplicate Denied',
    'FieldOps Mobile V2 Denied Fleet',
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
    jsonb_build_object('employee_or_contractor_id', 'DRV-FOPS-REJECT-DUP-' || left(replace(gen_random_uuid()::text, '-', ''), 8)),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-reject-duplicate',
    TRUE
  );
  v_rejected_dup_request := NULLIF(v_rejected_dup_create->>'id', '')::uuid;
  v_rejected_dup_token := NULLIF(v_rejected_dup_create->>'application_status_token', '')::uuid;
  v_rejected_dup_review := public.marketplace_participant_request_review_apply_v1(
    v_rejected_dup_request,
    'reject',
    NULL,
    NULL,
    FALSE,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('reason', 'duplicate_identity')
  );
  v_rejected_dup_status := public.marketplace_application_status_by_token_v1(v_rejected_dup_token);

  v_rejected_compliance_create := public.marketplace_participant_request_create_v1(
    'freelancer_driver',
    v_email_g,
    'FieldOps V2 Compliance Denied',
    'FieldOps Mobile V2 Denied Fleet',
    NULL,
    '+966507' || lpad((floor(random() * 999999))::int::text, 6, '0'),
    NULL,
    'en',
    'fieldops-mobile-v2-native://signup',
    NULL,
    'fieldops-mobile-v2-native://signup',
    NULL,
    jsonb_build_array('last_mile_driver'),
    jsonb_build_array(
      jsonb_build_object(
        'document_type_key', 'driver_license',
        'document_ref', 'DL-MISMATCH-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
        'status', 'rejected'
      )
    ),
    jsonb_build_object('employee_or_contractor_id', 'DRV-FOPS-REJECT-COMP-' || left(replace(gen_random_uuid()::text, '-', ''), 8)),
    jsonb_build_object('source', 'fieldops_mobile_v2_pgtap'),
    NULL,
    NULL,
    'fieldops-v2-ip-reject-compliance',
    TRUE
  );
  v_rejected_compliance_request := NULLIF(v_rejected_compliance_create->>'id', '')::uuid;
  v_rejected_compliance_token := NULLIF(v_rejected_compliance_create->>'application_status_token', '')::uuid;
  v_rejected_compliance_review := public.marketplace_participant_request_review_apply_v1(
    v_rejected_compliance_request,
    'reject',
    NULL,
    NULL,
    FALSE,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('reason', 'compliance_document_mismatch')
  );
  v_rejected_compliance_status := public.marketplace_application_status_by_token_v1(v_rejected_compliance_token);

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
    approved_create JSONB,
    approved_review JSONB,
    approved_status JSONB,
    rejected_dup_create JSONB,
    rejected_dup_review JSONB,
    rejected_dup_status JSONB,
    rejected_compliance_create JSONB,
    rejected_compliance_review JSONB,
    rejected_compliance_status JSONB
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
    v_approved_create,
    v_approved_review,
    v_approved_status,
    v_rejected_dup_create,
    v_rejected_dup_review,
    v_rejected_dup_status,
    v_rejected_compliance_create,
    v_rejected_compliance_review,
    v_rejected_compliance_status
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

SELECT ok((approved_review->>'ok')::boolean, 'Console approval provisions the Mobile V2 driver handoff')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(approved_status->>'application_state', 'approved', 'status token returns approved applicant state')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  (approved_status#>>'{profile_handoff,ready}')::boolean
  AND NULLIF(approved_status#>>'{profile_handoff,user_id}', '') IS NOT NULL
  AND NULLIF(approved_status#>>'{profile_handoff,participant_profile_id}', '') IS NOT NULL
  AND NULLIF(approved_status#>>'{profile_handoff,organization_id}', '') IS NOT NULL,
  'status token exposes backend-approved user, profile, and organization handoff ids'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  (approved_status#>>'{profile_handoff,fleet_handoff_ready}')::boolean
  AND NULLIF(approved_status#>>'{profile_handoff,driver_profile_id}', '') IS NOT NULL
  AND approved_status#>>'{profile_handoff,fleet_driver_status}' = 'active'
  AND (approved_status#>>'{profile_handoff,fleet_document_count}')::int >= 1
  AND (approved_status#>>'{profile_handoff,fleet_compliance_event_count}')::int >= 1,
  'status token exposes backend-confirmed fleet driver profile and compliance handoff readback'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(
  approved_status#>>'{profile_handoff,invite_redirect_to}',
  'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
  'status token exposes approved Mobile V2 invite redirect handoff'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok((rejected_dup_review->>'ok')::boolean, 'Console duplicate-identity rejection applies through canonical review RPC')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(rejected_dup_status->>'application_state', 'duplicate_identity', 'status token maps duplicate rejection from row-driven review reason edge metadata')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok(
  rejected_dup_status->>'status' = 'rejected'
  AND rejected_dup_status->>'review_reason' = 'duplicate_identity'
  AND COALESCE((rejected_dup_status#>>'{profile_handoff,ready}')::boolean, FALSE) IS FALSE
  AND COALESCE((rejected_dup_status#>>'{profile_handoff,fleet_handoff_ready}')::boolean, FALSE) IS FALSE,
  'duplicate denied state does not expose Mobile V2 profile handoff'
)
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT ok((rejected_compliance_review->>'ok')::boolean, 'Console compliance-document rejection applies through canonical review RPC')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT is(rejected_compliance_status->>'application_state', 'compliance_denied', 'status token maps compliance rejection from row-driven review reason edge metadata')
FROM fieldops_mobile_v2_driver_signup_status_results;

SELECT * FROM finish();
ROLLBACK;
