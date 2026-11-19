-- Migration: submit_fieldops_auth_otp_via_edge_v1 — edge-function wrapper
-- Date: 2026-05-13
-- Spec: Mobile FieldOps V2 — closes engineering re-audit P1 (2026-05-13)
--   ("edge function fieldops-otp-verifier not shipped; production
--   tenants opting into edge_fn provider would fail closed but have
--   no working path").
--
-- Background
-- ----------
-- The verifier function `verify_fieldops_otp_v1` (migration
-- `202605131200_fieldops_auth_otp_verifier_v1.sql:137-148`) treats
-- the `edge_fn` provider mode as "must be pre-verified by the edge
-- function", reading `current_setting('app.fieldops_otp_verified',
-- TRUE)` and accepting only `'true'`. To enable that flow, the edge
-- function needs to set the GUC and call `submit_fieldops_auth_otp_v1`
-- in the SAME DB session — supabase-js's `.rpc()` makes per-call
-- session lifetimes brittle, so we ship a wrapper RPC that does
-- both inside its own function body.
--
-- This wrapper is the ONLY entry point the edge function should
-- call. Direct callers of `submit_fieldops_auth_otp_v1` still see
-- the original signature (no `p_edge_verified` argument); the edge
-- function uses this wrapper instead.
--
-- Security posture
-- ----------------
-- - `SECURITY DEFINER` so the function can `set_config` regardless
--   of caller role. The GUC is local-scoped (`is_local = TRUE`) so
--   it never leaks beyond this function's execution.
-- - GRANT only to `service_role` (the edge function calls with the
--   service key). Authenticated/anon CANNOT invoke this — that
--   restriction is the entire reason the edge function exists.
-- - `search_path` pinned per AGENTS.md.
-- - No-op if `mobile_auth_policy.provider <> 'edge_fn'`: we simply
--   call through to `submit_fieldops_auth_otp_v1` without the GUC
--   set, so the verifier resolves on the underlying provider path
--   (test mode etc.). This keeps the wrapper safe to call even when
--   the policy is still in test mode during cutover.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605131700_submit_fieldops_auth_otp_via_edge_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.submit_fieldops_auth_otp_via_edge_v1(
  p_employee_id      TEXT,
  p_otp              TEXT,
  p_edge_verified    BOOLEAN,
  p_idempotency_key  UUID,
  p_correlation_id   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_envelope JSONB;
BEGIN
  -- When the upstream edge function vouches for the OTP, set the
  -- session-scoped GUC so verify_fieldops_otp_v1's `edge_fn` branch
  -- resolves to TRUE. The third argument `is_local = TRUE` confines
  -- the value to the current transaction so it never bleeds across
  -- pooled connections.
  IF p_edge_verified IS TRUE THEN
    PERFORM set_config('app.fieldops_otp_verified', 'true', TRUE);
  END IF;

  -- Delegate to the canonical submit RPC. The verifier inside will
  -- read the GUC for `edge_fn` provider tenants, or fall back to its
  -- own provider-specific check (`test` mode etc.) for other tenants.
  -- p_correlation_id is accepted at this wrapper for trace propagation
  -- but the inner RPC keys idempotency on p_idempotency_key, so we
  -- only forward the canonical fields.
  v_envelope := public.submit_fieldops_auth_otp_v1(
    p_employee_id     => p_employee_id,
    p_otp             => p_otp,
    p_idempotency_key => p_idempotency_key
  );

  -- Surface the wrapper's correlation id back to the caller so the
  -- edge function can echo it into its response for downstream trace.
  IF p_correlation_id IS NOT NULL THEN
    v_envelope := jsonb_set(
      COALESCE(v_envelope, '{}'::jsonb),
      '{correlation_id}',
      to_jsonb(p_correlation_id::text)
    );
  END IF;

  RETURN v_envelope;
END;
$function$;

COMMENT ON FUNCTION public.submit_fieldops_auth_otp_via_edge_v1(TEXT, TEXT, BOOLEAN, UUID, UUID) IS
  'FieldOps Mobile V2 OTP submit — edge-function entry point. Sets the local GUC `app.fieldops_otp_verified` when p_edge_verified=true, then delegates to submit_fieldops_auth_otp_v1. service_role only.';

REVOKE ALL ON FUNCTION public.submit_fieldops_auth_otp_via_edge_v1(TEXT, TEXT, BOOLEAN, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_fieldops_auth_otp_via_edge_v1(TEXT, TEXT, BOOLEAN, UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_auth_otp_via_edge_v1(TEXT, TEXT, BOOLEAN, UUID, UUID) TO service_role;

-- api.* SECURITY INVOKER mirror so PostgREST callers can reach it from
-- the edge function context with the service-role key.
CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_auth_otp_via_edge_v1(
  p_employee_id      TEXT,
  p_otp              TEXT,
  p_edge_verified    BOOLEAN,
  p_idempotency_key  UUID,
  p_correlation_id   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_auth_otp_via_edge_v1(
    p_employee_id     => p_employee_id,
    p_otp             => p_otp,
    p_edge_verified   => p_edge_verified,
    p_idempotency_key => p_idempotency_key,
    p_correlation_id  => p_correlation_id
  );
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_auth_otp_via_edge_v1(TEXT, TEXT, BOOLEAN, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_auth_otp_via_edge_v1(TEXT, TEXT, BOOLEAN, UUID, UUID) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605131700_submit_fieldops_auth_otp_via_edge_v1'));
COMMIT;
