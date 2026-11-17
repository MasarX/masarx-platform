-- Plan: PLAN-202602-tenant-signup-approval-onboarding-defaults / Step: S99
-- Migration: Replace tenant_signup_requests email CHECK with regex form (no IN(...) pattern)
-- Why:
-- - pgTAP 0zz_no_literal_enum_checks.sql flags CHECK definitions containing IN(...).
-- - POSITION('@' IN email) is a non-enum check but still matches that detector pattern.

BEGIN;

ALTER TABLE public.tenant_signup_requests
  DROP CONSTRAINT IF EXISTS tenant_signup_requests_email_ck;

ALTER TABLE public.tenant_signup_requests
  ADD CONSTRAINT tenant_signup_requests_email_ck
  CHECK (
    email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  );

COMMIT;
