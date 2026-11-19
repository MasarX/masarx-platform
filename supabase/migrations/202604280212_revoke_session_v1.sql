-- Spec-Issue: Phase B6 - Identity RPC contract: revoke_session_v1
-- Step: B6-RPC-12
-- Capability: users.manage
--
-- Architectural decision (revoke_session_v1):
-- Supabase manages user sessions in auth.sessions (auth schema, server-managed).
-- SECURITY DEFINER functions in public schema cannot directly mutate auth.sessions
-- in production posture without elevated grants we choose not to expose. Therefore
-- this RPC writes a canonical revocation INTENT row to public.revocation_audit
-- (foundation migration). An out-of-band edge function consumes the ledger
-- (status='pending') and invokes auth.admin.signOut(user_id) via the Supabase
-- Admin API, then marks the row processed_at + status='completed'/'failed'.
--
-- The DB RPC is the SSOT for the revocation intent. Console UI surfaces the
-- pending->completed transition via correlation_id polling.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280212_revoke_session_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.revoke_session_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID;
  v_target_user_id UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_session_id TEXT := NULLIF(btrim(COALESCE(p_args->>'session_id', '')), '');
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'revoke_session_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.manage');

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'revoke_session_v1 requires target_user_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT organization_id INTO v_target_org FROM public.users WHERE id = v_target_user_id;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'revoke_session_v1 target user % not found', v_target_user_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'revoke_session_v1 target user % outside tenant scope', v_target_user_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.revocation_audit (
    organization_id, target_user_id, session_id, reason,
    revoked_by, status, correlation_id, decision_log_id
  ) VALUES (
    v_target_org, v_target_user_id, v_session_id, v_reason,
    v_user_id, 'pending', v_correlation_id, v_decision_id
  )
  RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org, 'sessions.revoke', 'user', v_target_user_id,
    'revoke_session_v1', 'pending',
    jsonb_strip_nulls(jsonb_build_object('session_id', v_session_id, 'reason', v_reason)),
    'revoke_session_v1', v_correlation_id::uuid
  );

  -- Domain event triggers the edge worker that calls Supabase Admin API.
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'session.revocation_requested', 'user', v_target_user_id,
    jsonb_strip_nulls(jsonb_build_object(
      'revocation_audit_id', v_resource_id,
      'session_id', v_session_id,
      'reason', v_reason
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'revocation_audit_id', v_resource_id,
    'target_user_id', v_target_user_id,
    'status', 'pending',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_session_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_session_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_session_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.revoke_session_v1(jsonb)
  IS 'Canonical write RPC: enqueue revocation intent in revocation_audit (consumed by edge worker that invokes auth.admin.signOut). Capability: users.manage. SSOT for revocation INTENT; auth.sessions termination performed out-of-band.';

SELECT pg_advisory_unlock(hashtext('202604280212_revoke_session_v1'));
COMMIT;
