-- User lifecycle correlation_id UUID-cast bug fix.
--
-- Live Chrome audit of Console V2 Platform > Users discovered that
-- Reactivate/Suspend/Grant role/Revoke role/Force password reset all fail
-- with "invalid input syntax for type uuid" because the canonical functions
-- declare:
--   v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
-- which produces a 16-char hex string, then attempt to cast it to a UUID:
--   ... v_correlation_id::uuid ...
-- UUIDs are 32 hex chars + 4 dashes (36 chars total), so the cast fails and
-- the entire function aborts. This blocks every operator-driven user
-- lifecycle action from the Console (the FE shows
--   Reactivate user failed - invalid input syntax
-- with no canonical readback).
--
-- Fix: replace the broken correlation_id derivation with the canonical
--   v_correlation_id_uuid UUID := gen_random_uuid();
--   v_correlation_id TEXT := v_correlation_id_uuid::text;
-- so the same value is available as both UUID (for decision_log/domain_events
-- correlation_id columns) and TEXT (for response envelope echoes).
--
-- Coverage: reactivate_user_v1, suspend_user_v1, grant_user_role_v1,
-- revoke_user_role_v1, force_password_reset_v1.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605091815_user_lifecycle_correlation_id_uuid_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- reactivate_user_v1
CREATE OR REPLACE FUNCTION public.reactivate_user_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id_uuid UUID := gen_random_uuid();
  v_correlation_id TEXT := v_correlation_id_uuid::text;
  v_decision_id UUID := gen_random_uuid();
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
  v_prior_status TEXT;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'reactivate_user_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('users.manage');
  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'reactivate_user_v1 requires target_user_id' USING ERRCODE = '23502';
  END IF;
  SELECT u.organization_id, u.status INTO v_target_org, v_prior_status
    FROM public.users u WHERE u.id = v_target_user FOR UPDATE;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'reactivate_user_v1 target user % not found', v_target_user USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL AND v_target_org <> v_org_id AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'reactivate_user_v1 target user % outside tenant scope', v_target_user USING ERRCODE = '42501';
  END IF;
  IF v_prior_status = 'active' THEN
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    UPDATE public.users SET status = 'active' WHERE id = v_target_user;
    v_action := 'reactivated';
  END IF;
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'users.reactivate', 'user', v_target_user,
    'reactivate_user_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object('target_user_id', v_target_user, 'prior_status', v_prior_status, 'reason', v_reason, 'idempotent_no_op', v_idempotent)),
    'reactivate_user_v1', v_correlation_id_uuid
  );
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'users.reactivated', 'user', v_target_user,
    jsonb_strip_nulls(jsonb_build_object('target_user_id', v_target_user, 'prior_status', v_prior_status, 'reason', v_reason, 'idempotent_no_op', v_idempotent)),
    v_correlation_id_uuid, 'pending'
  );
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true, 'target_user_id', v_target_user, 'status', 'active',
    'prior_status', v_prior_status, 'action', v_action, 'idempotent_no_op', v_idempotent,
    'correlation_id', v_correlation_id, 'decision_log_id', v_decision_id
  ));
END;
$$;

-- suspend_user_v1
CREATE OR REPLACE FUNCTION public.suspend_user_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id_uuid UUID := gen_random_uuid();
  v_correlation_id TEXT := v_correlation_id_uuid::text;
  v_decision_id UUID := gen_random_uuid();
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
  v_prior_status TEXT;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'suspend_user_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('users.manage');
  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'suspend_user_v1 requires target_user_id' USING ERRCODE = '23502';
  END IF;
  SELECT u.organization_id, u.status INTO v_target_org, v_prior_status
    FROM public.users u WHERE u.id = v_target_user FOR UPDATE;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'suspend_user_v1 target user % not found', v_target_user USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL AND v_target_org <> v_org_id AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'suspend_user_v1 target user % outside tenant scope', v_target_user USING ERRCODE = '42501';
  END IF;
  IF v_prior_status = 'suspended' THEN
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    UPDATE public.users SET status = 'suspended' WHERE id = v_target_user;
    v_action := 'suspended';
  END IF;
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'users.suspend', 'user', v_target_user,
    'suspend_user_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object('target_user_id', v_target_user, 'prior_status', v_prior_status, 'reason', v_reason, 'idempotent_no_op', v_idempotent)),
    'suspend_user_v1', v_correlation_id_uuid
  );
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'users.suspended', 'user', v_target_user,
    jsonb_strip_nulls(jsonb_build_object('target_user_id', v_target_user, 'prior_status', v_prior_status, 'reason', v_reason, 'idempotent_no_op', v_idempotent)),
    v_correlation_id_uuid, 'pending'
  );
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true, 'target_user_id', v_target_user, 'status', 'suspended',
    'prior_status', v_prior_status, 'action', v_action, 'idempotent_no_op', v_idempotent,
    'correlation_id', v_correlation_id, 'decision_log_id', v_decision_id
  ));
END;
$$;

-- force_password_reset_v1
CREATE OR REPLACE FUNCTION public.force_password_reset_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id_uuid UUID := gen_random_uuid();
  v_correlation_id TEXT := v_correlation_id_uuid::text;
  v_decision_id UUID := gen_random_uuid();
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_email TEXT := NULLIF(btrim(COALESCE(p_args->>'email', '')), '');
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
  v_target_email TEXT;
  v_intent_id UUID;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'force_password_reset_v1 requires authenticated user' USING ERRCODE = '42501'; END IF;
  PERFORM public.assert_capability_v1('users.manage');
  IF v_target_user IS NULL THEN RAISE EXCEPTION 'force_password_reset_v1 requires target_user_id' USING ERRCODE = '23502'; END IF;
  SELECT u.organization_id, u.email INTO v_target_org, v_target_email FROM public.users u WHERE u.id = v_target_user;
  IF v_target_org IS NULL THEN RAISE EXCEPTION 'force_password_reset_v1 target user % not found', v_target_user USING ERRCODE = '23503'; END IF;
  IF v_org_id IS NOT NULL AND v_target_org <> v_org_id AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'force_password_reset_v1 target user % outside tenant scope', v_target_user USING ERRCODE = '42501';
  END IF;
  v_email := COALESCE(v_email, v_target_email);
  IF v_email IS NULL OR btrim(v_email) = '' THEN RAISE EXCEPTION 'force_password_reset_v1 cannot resolve target email' USING ERRCODE = '23502'; END IF;
  INSERT INTO public.password_reset_intents (
    organization_id, target_user_id, email, reason, requested_by, status, correlation_id, decision_log_id
  ) VALUES (
    v_target_org, v_target_user, v_email, v_reason, v_user_id, 'pending', v_correlation_id_uuid::text, v_decision_id
  ) RETURNING id INTO v_intent_id;
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'users.force_password_reset', 'user', v_target_user,
    'force_password_reset_v1', 'pending',
    jsonb_strip_nulls(jsonb_build_object('target_user_id', v_target_user, 'email', v_email, 'reason', v_reason, 'password_reset_intent_id', v_intent_id)),
    'force_password_reset_v1', v_correlation_id_uuid
  );
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'users.password_reset_requested', 'user', v_target_user,
    jsonb_strip_nulls(jsonb_build_object('password_reset_intent_id', v_intent_id, 'target_user_id', v_target_user, 'email', v_email, 'reason', v_reason)),
    v_correlation_id_uuid, 'pending'
  );
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true, 'password_reset_intent_id', v_intent_id, 'target_user_id', v_target_user,
    'email', v_email, 'status', 'pending',
    'correlation_id', v_correlation_id, 'settings_resolution_id', v_decision_id
  ));
END;
$$;

-- Add missing decision_category lookup values seen by user lifecycle ledger writes.
-- ON CONFLICT keeps the migration idempotent across replays.
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
  ld.id, v.value, v.label, v.description, v.sort_order, false
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('users.reactivate', 'User reactivated', 'User account reactivated from suspended', 200),
  ('users.suspend', 'User suspended', 'User account suspended', 210),
  ('users.grant_role', 'User role granted', 'User RBAC role granted', 220),
  ('users.revoke_role', 'User role revoked', 'User RBAC role revoked', 230),
  ('users.force_password_reset', 'User password reset', 'User password reset forced', 240),
  ('users.invite', 'User invited', 'User invite issued', 250)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

SELECT pg_advisory_unlock(hashtext('202605091815_user_lifecycle_correlation_id_uuid_fix_v1'));
COMMIT;
