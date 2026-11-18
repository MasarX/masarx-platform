-- Spec-Issue: Wave 8 W8-3 PLATFORM user-lifecycle RPC closure (CLAIM-PLATFORM-USERS)
-- Step: B-RPC-User-Force-Password-Reset
-- Capability: users.manage
--
-- Architectural decision (force_password_reset_v1):
-- The actual password reset path is server-managed (Supabase auth.users:
-- auth.admin.resetPasswordForEmail / auth.admin.generateLink). SECURITY DEFINER
-- functions in public schema cannot directly mutate the auth schema in our
-- production posture without elevated grants we choose not to expose. Therefore
-- this RPC writes a canonical reset INTENT row to public.password_reset_intents
-- and emits a domain_event the out-of-band edge worker consumes to invoke the
-- Supabase Admin API. The worker marks the row processed_at + status=
-- 'completed'/'failed'.
--
-- This is the same INTENT-ledger pattern used by revoke_session_v1
-- (supabase/migrations/202604280212_revoke_session_v1.sql).
--
-- The DB RPC is the SSOT for the reset intent. Console UI surfaces the
-- pending->completed transition via correlation_id polling.
--
-- Canonical envelope: { ok, password_reset_intent_id, target_user_id, email,
-- status, correlation_id, settings_resolution_id }.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300340_force_password_reset_v1'));
SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) public.password_reset_intents (INTENT ledger; service-only RLS)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.password_reset_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NULL,
  requested_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  CONSTRAINT password_reset_intents_status_ck CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  ),
  CONSTRAINT password_reset_intents_email_ck CHECK (
    btrim(email) <> '' AND email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
  )
);

CREATE INDEX IF NOT EXISTS idx_password_reset_intents_target
  ON public.password_reset_intents (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_intents_status
  ON public.password_reset_intents (status, created_at);

COMMENT ON TABLE public.password_reset_intents
  IS 'Canonical password-reset intent ledger; consumed by out-of-band edge worker that invokes Supabase Admin API auth.admin.resetPasswordForEmail / generateLink.';

ALTER TABLE public.password_reset_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.password_reset_intents FROM PUBLIC;
REVOKE ALL ON TABLE public.password_reset_intents FROM anon;
REVOKE ALL ON TABLE public.password_reset_intents FROM authenticated;
GRANT ALL ON TABLE public.password_reset_intents TO service_role;

DROP POLICY IF EXISTS password_reset_intents_service_policy ON public.password_reset_intents;
CREATE POLICY password_reset_intents_service_policy
  ON public.password_reset_intents
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 2) public.force_password_reset_v1(p_args jsonb)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.force_password_reset_v1(p_args jsonb)
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
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_email TEXT := NULLIF(btrim(COALESCE(p_args->>'email', '')), '');
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
  v_target_email TEXT;
  v_intent_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'force_password_reset_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.manage');

  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'force_password_reset_v1 requires target_user_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT u.organization_id, u.email INTO v_target_org, v_target_email
    FROM public.users u WHERE u.id = v_target_user;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'force_password_reset_v1 target user % not found', v_target_user
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'force_password_reset_v1 target user % outside tenant scope', v_target_user
      USING ERRCODE = '42501';
  END IF;

  -- Resolve target email: explicit override or canonical user email.
  v_email := COALESCE(v_email, v_target_email);
  IF v_email IS NULL OR btrim(v_email) = '' THEN
    RAISE EXCEPTION 'force_password_reset_v1 cannot resolve target email'
      USING ERRCODE = '23502';
  END IF;

  INSERT INTO public.password_reset_intents (
    organization_id, target_user_id, email, reason,
    requested_by, status, correlation_id, decision_log_id
  ) VALUES (
    v_target_org, v_target_user, v_email, v_reason,
    v_user_id, 'pending', v_correlation_id, v_decision_id
  )
  RETURNING id INTO v_intent_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'users.force_password_reset', 'user', v_target_user,
    'force_password_reset_v1', 'pending',
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'email', v_email,
      'reason', v_reason,
      'password_reset_intent_id', v_intent_id
    )),
    'force_password_reset_v1', v_correlation_id::uuid
  );

  -- Domain event triggers the edge worker that calls Supabase Admin API.
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'users.password_reset_requested', 'user', v_target_user,
    jsonb_strip_nulls(jsonb_build_object(
      'password_reset_intent_id', v_intent_id,
      'target_user_id', v_target_user,
      'email', v_email,
      'reason', v_reason
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'password_reset_intent_id', v_intent_id,
    'target_user_id', v_target_user,
    'email', v_email,
    'status', 'pending',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.force_password_reset_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.force_password_reset_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.force_password_reset_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.force_password_reset_v1(jsonb)
  IS 'Canonical write RPC: enqueue password-reset intent in password_reset_intents (consumed by edge worker that invokes auth.admin.resetPasswordForEmail / generateLink). Capability: users.manage. SSOT for reset INTENT; auth.users mutation performed out-of-band.';

SELECT pg_advisory_unlock(hashtext('202604300340_force_password_reset_v1'));
COMMIT;
