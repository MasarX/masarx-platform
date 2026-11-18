-- pgTAP: public.v_driver_application_directory projection contract
-- Spec-Issue: W29 (paired projection views — FLEET)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_driver_application_directory',
  'public.v_driver_application_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_driver_application_directory',
  ARRAY[
    'id', 'created_at', 'updated_at', 'status', 'review_decision',
    'requested_participant_type_key',
    'requested_by_user_id', 'requested_organization_id',
    'email', 'full_name', 'organization_name', 'organization_slug',
    'phone', 'website_url', 'locale', 'page_url', 'referrer', 'origin',
    'experience_summary',
    'capabilities_requested', 'verification_documents',
    'marketing', 'metadata', 'turnstile_verified',
    'reviewed_at', 'reviewed_by', 'review_reason', 'decision_metadata',
    'approved_organization_id', 'approved_user_id',
    'approved_participant_profile_id',
    'invite_email_sent_at', 'invite_redirect_to',
    'reviewer_label', 'reviewer_email',
    'capabilities_count', 'verification_documents_count',
    'submitted_document_count', 'missing_document_count',
    'is_pending', 'is_approved', 'is_rejected', 'is_withdrawn',
    'is_terminal',
    'age_seconds', 'decision_age_seconds', 'sla_breach',
    'driver_profile_id', 'fleet_driver_status', 'fleet_handoff_ready',
    'fleet_document_count', 'fleet_compliance_event_count',
    'fleet_last_compliance_event_at'
  ],
  'v_driver_application_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_driver_application_directory', 'SELECT'),
  'service_role has SELECT on v_driver_application_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_driver_application_directory', 'SELECT'),
  'anon has no SELECT on v_driver_application_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_driver_application_directory', 'SELECT'),
  'authenticated has SELECT on v_driver_application_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'marketplace_participant_requests'
       AND c.relkind = 'r'
  ),
  'public.marketplace_participant_requests remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a freelancer_driver application + a non-driver
--    application (filtered out) + a pending request older than 7 days
--    (sla_breach=TRUE), then verify counters and booleans + filter.
DO $$
DECLARE
  v_org           UUID := '00000000-0000-0000-0000-00000029c001';
  v_reviewer      UUID := '00000000-0000-0000-0000-00000029c002';
  v_app_pending   UUID := '00000000-0000-0000-0000-00000029c003';
  v_app_approved  UUID := '00000000-0000-0000-0000-00000029c004';
  v_app_other     UUID := '00000000-0000-0000-0000-00000029c005';
  v_pending_count INT;
  v_other_count   INT;
  v_review_label  TEXT;
  v_caps          INT;
  v_docs          INT;
  v_subm          INT;
  v_miss          INT;
  v_pending       BOOLEAN;
  v_approved      BOOLEAN;
  v_terminal      BOOLEAN;
  v_age           BIGINT;
  v_dec_age       BIGINT;
  v_sla           BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W29 App Org', 'w29-app-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_reviewer, v_org, 'w29-app-rev-' || left(v_reviewer::text, 8) || '@example.com',
    'W29 Reviewer', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  -- App #1: pending freelancer_driver, > 7 days old → sla_breach=TRUE.
  INSERT INTO public.marketplace_participant_requests (
    id, status, requested_participant_type_key,
    email, full_name, organization_name,
    capabilities_requested, verification_documents,
    turnstile_verified, created_at
  )
  VALUES (
    v_app_pending, 'pending', 'freelancer_driver',
    'w29-applicant-1@example.com', 'W29 Applicant Pending',
    'W29 LLC',
    jsonb_build_array('long_haul', 'cold_chain'),
    jsonb_build_array(
      jsonb_build_object('type', 'license', 'status', 'submitted'),
      jsonb_build_object('type', 'national_id', 'status', 'missing'),
      jsonb_build_object('type', 'medical', 'status', 'submitted')
    ),
    TRUE,
    now() - INTERVAL '10 days'
  )
  ON CONFLICT (id) DO NOTHING;

  -- App #2: approved freelancer_driver, reviewed 2 days ago.
  INSERT INTO public.marketplace_participant_requests (
    id, status, review_decision, requested_participant_type_key,
    email, full_name, organization_name,
    capabilities_requested, verification_documents,
    turnstile_verified, reviewed_at, reviewed_by, review_reason,
    created_at
  )
  VALUES (
    v_app_approved, 'approved', 'approved', 'freelancer_driver',
    'w29-applicant-2@example.com', 'W29 Applicant Approved',
    'W29 LLC 2',
    jsonb_build_array('local_delivery'),
    jsonb_build_array(
      jsonb_build_object('type', 'license', 'status', 'submitted')
    ),
    TRUE,
    now() - INTERVAL '2 days', v_reviewer, 'documents_verified',
    now() - INTERVAL '5 days'
  )
  ON CONFLICT (id) DO NOTHING;

  -- App #3: NOT a freelancer_driver (must be filtered out).
  INSERT INTO public.marketplace_participant_requests (
    id, status, requested_participant_type_key,
    email, full_name, organization_name,
    turnstile_verified, created_at
  )
  VALUES (
    v_app_other, 'pending', 'service_provider',
    'w29-applicant-3@example.com', 'W29 Other Applicant',
    'W29 LLC 3',
    TRUE, now() - INTERVAL '1 day'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Verify the non-driver application is filtered out at the view layer.
  SELECT COUNT(*)::INT INTO v_other_count
    FROM public.v_driver_application_directory
   WHERE id = v_app_other;

  -- Verify the pending freelancer_driver row.
  SELECT
    reviewer_label, capabilities_count, verification_documents_count,
    submitted_document_count, missing_document_count,
    is_pending, is_approved, is_terminal,
    age_seconds, decision_age_seconds, sla_breach
    INTO
    v_review_label, v_caps, v_docs,
    v_subm, v_miss,
    v_pending, v_approved, v_terminal,
    v_age, v_dec_age, v_sla
    FROM public.v_driver_application_directory
   WHERE id = v_app_pending;

  PERFORM ok(
    v_other_count = 0
      AND v_review_label IS NULL
      AND v_caps = 2
      AND v_docs = 3
      AND v_subm = 2
      AND v_miss = 1
      AND v_pending = TRUE
      AND v_approved = FALSE
      AND v_terminal = FALSE
      AND v_age IS NOT NULL
      AND v_age > 60 * 60 * 24 * 9   -- > 9 days
      AND v_dec_age IS NULL
      AND v_sla = TRUE,              -- pending > 7 days
    'v_driver_application_directory filters non-driver requests, derives capabilities_count + verification_documents_count + submitted/missing counts + lifecycle booleans + age_seconds + sla_breach'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
