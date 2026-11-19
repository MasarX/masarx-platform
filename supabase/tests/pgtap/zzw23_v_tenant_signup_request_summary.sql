-- pgTAP: public.v_tenant_signup_request_summary projection contract (shape/RLS/projection)
-- Spec-Issue: W23 (paired projection views — IDENTITY)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_tenant_signup_request_summary',
  'public.v_tenant_signup_request_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_tenant_signup_request_summary',
  ARRAY[
    'id', 'created_at', 'updated_at', 'status', 'review_decision',
    'email', 'full_name', 'organization_name', 'organization_slug',
    'website_url', 'phone', 'notes', 'locale',
    'page_url', 'referrer', 'origin',
    'marketing', 'metadata',
    'ip_hash', 'turnstile_verified',
    'reviewed_at', 'reviewed_by', 'review_reason', 'decision_metadata',
    'approved_organization_id', 'approved_user_id', 'approved_auth_user_id',
    'invite_email_sent_at', 'invite_redirect_to',
    'last_error_code', 'last_error_message', 'last_error_at',
    'reviewer_label', 'reviewer_email',
    'approved_organization_label', 'approved_user_email',
    'attestation_count', 'attestation_passed_count', 'attestation_complete',
    'has_marketing_consent',
    'is_pending', 'is_approved', 'is_rejected',
    'decision_age_seconds'
  ],
  'v_tenant_signup_request_summary exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_tenant_signup_request_summary', 'SELECT'),
  'service_role has SELECT on v_tenant_signup_request_summary'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_tenant_signup_request_summary', 'SELECT'),
  'anon has no SELECT on v_tenant_signup_request_summary'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_tenant_signup_request_summary', 'SELECT'),
  'authenticated has SELECT on v_tenant_signup_request_summary'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_signup_requests'
       AND c.relkind = 'r'
  ),
  'public.tenant_signup_requests remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a request with attestations + reviewer; verify rollups.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000023c000';
  v_reviewer UUID := '00000000-0000-0000-0000-00000023c001';
  v_request UUID := '00000000-0000-0000-0000-00000023c002';
  v_att_count INT;
  v_att_passed INT;
  v_complete BOOLEAN;
  v_reviewer_label TEXT;
  v_is_approved BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W23 Signup Reviewer Org', 'w23-signup-reviewer-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status,
    access_scope_type, access_scope_id, created_at
  )
  VALUES (
    v_reviewer, v_org,
    'w23-reviewer@example.invalid', 'W23 Reviewer',
    'ops_admin', 'active',
    'tenant', NULL, now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenant_signup_requests (
    id, status, review_decision,
    email, full_name, organization_name,
    marketing, metadata, turnstile_verified,
    reviewed_at, reviewed_by, review_reason
  )
  VALUES (
    v_request, 'approved', 'approved',
    'w23-applicant@example.invalid', 'W23 Applicant', 'W23 Applicant Inc',
    '{"consent": true, "campaign": "w23-test"}'::jsonb,
    '{"attestations": {"terms_accepted": true, "privacy_accepted": true, "kyc_documents_provided": true}}'::jsonb,
    TRUE,
    now(), v_reviewer, 'Approved for W23 view test'
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT attestation_count, attestation_passed_count, attestation_complete,
         reviewer_label, is_approved
    INTO v_att_count, v_att_passed, v_complete, v_reviewer_label, v_is_approved
    FROM public.v_tenant_signup_request_summary
   WHERE id = v_request;

  PERFORM ok(
    v_att_count = 3
      AND v_att_passed = 3
      AND v_complete = TRUE
      AND v_reviewer_label = 'W23 Reviewer'
      AND v_is_approved = TRUE,
    'v_tenant_signup_request_summary projects attestation_count + attestation_passed_count + attestation_complete + reviewer_label + is_approved'
  );
END;
$$;

-- 8) Negative path: missing attestations or turnstile fail collapses attestation_complete to FALSE.
DO $$
DECLARE
  v_request UUID := '00000000-0000-0000-0000-00000023c010';
  v_complete BOOLEAN;
  v_consent BOOLEAN;
  v_is_pending BOOLEAN;
  v_age INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.tenant_signup_requests (
    id, status,
    email, full_name, organization_name,
    marketing, metadata, turnstile_verified
  )
  VALUES (
    v_request, 'pending',
    'w23-pending@example.invalid', 'W23 Pending Applicant', 'W23 Pending Inc',
    '{"consent": false}'::jsonb,
    '{"attestations": {"terms_accepted": true, "privacy_accepted": false}}'::jsonb,
    FALSE
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT attestation_complete, has_marketing_consent, is_pending, decision_age_seconds
    INTO v_complete, v_consent, v_is_pending, v_age
    FROM public.v_tenant_signup_request_summary
   WHERE id = v_request;

  PERFORM ok(
    v_complete = FALSE
      AND v_consent = FALSE
      AND v_is_pending = TRUE
      AND v_age IS NULL,
    'v_tenant_signup_request_summary collapses attestation_complete to FALSE for incomplete attestations + non-verified turnstile, and decision_age_seconds is NULL when pending'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
