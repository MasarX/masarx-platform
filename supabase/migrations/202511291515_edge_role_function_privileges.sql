-- Migration: Edge function execution privileges hardening
-- Purpose:
--   Ensure that only designated edge roles and service_role can execute
--   sensitive helper functions; anon/authenticated must be denied, matching
--   RLS and pgTAP expectations.

BEGIN;

-- get_webhook_source_by_token(text): only edge_webhook_role + service_role.
REVOKE EXECUTE ON FUNCTION public.get_webhook_source_by_token(text)
  FROM anon, authenticated;

-- get_job_call_spec(uuid): only edge_api_caller_role + service_role.
REVOKE EXECUTE ON FUNCTION public.get_job_call_spec(uuid)
  FROM anon, authenticated;

-- lease_label_job(uuid, integer, uuid): only label renderer edge roles + service_role.
REVOKE EXECUTE ON FUNCTION public.lease_label_job(uuid, integer, uuid)
  FROM anon, authenticated;

COMMIT;

