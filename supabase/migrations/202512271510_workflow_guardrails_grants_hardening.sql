-- Migration: workflow_guardrails grants hardening
-- Purpose: keep workflow_guardrails out of user-facing surface area (service role only).

BEGIN;

REVOKE ALL ON TABLE public.workflow_guardrails FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_guardrails FROM anon;
REVOKE ALL ON TABLE public.workflow_guardrails FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflow_guardrails TO service_role;

COMMIT;
