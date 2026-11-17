-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Harden bank reconciliation function privileges (service-only)
-- Date: 2026-01-22

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221145_bank_reconciliation_function_privileges_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Ensure service-only execution paths remain service-only even if the project
-- has broader default GRANT EXECUTE policies for authenticated.
REVOKE ALL ON FUNCTION public.resolve_bank_reconciliation_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_bank_reconciliation_policy(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_bank_reconciliation_policy(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_bank_reconciliation_policy(JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.record_bank_statement_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_bank_statement_event_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.record_bank_statement_event_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_bank_statement_event_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601221145_bank_reconciliation_function_privileges_fix'));
COMMIT;

