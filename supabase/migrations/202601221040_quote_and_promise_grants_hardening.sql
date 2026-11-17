-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: quote_and_promise_v1 grants hardening (service-only)
-- Date: 2026-01-22
--
-- Notes:
--   - This is a fixup migration to enforce service-only execution.
--   - Some environments may have broad EXECUTE grants; explicitly revoke from anon/authenticated.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221040_quote_and_promise_grants_hardening'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.quote_and_promise_v1(JSONB, UUID, TEXT, TEXT, NUMERIC, INT, NUMERIC, TIMESTAMPTZ, DATE, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.quote_and_promise_v1(JSONB, UUID, TEXT, TEXT, NUMERIC, INT, NUMERIC, TIMESTAMPTZ, DATE, TEXT, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.quote_and_promise_v1(JSONB, UUID, TEXT, TEXT, NUMERIC, INT, NUMERIC, TIMESTAMPTZ, DATE, TEXT, UUID, TEXT, TEXT) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.quote_and_promise_v1(JSONB, UUID, TEXT, TEXT, NUMERIC, INT, NUMERIC, TIMESTAMPTZ, DATE, TEXT, UUID, TEXT, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601221040_quote_and_promise_grants_hardening'));
COMMIT;

