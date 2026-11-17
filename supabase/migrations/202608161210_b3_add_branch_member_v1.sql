-- Spec-Issue: NETWORK W9 — close residual gaps on branches/zones canonical write RPCs
-- Step: W9-S01
-- Migration: add_branch_member_v1
-- Capability: branches.write
-- Date: 2026-04-30
--
-- Purpose:
--   Canonical write RPC: insert public.branch_memberships row + decision_log + domain_event.
--   Replaces the FE phaseC6Rpc shim path (NETWORK gap closure).
--
-- Args (jsonb):
--   { branch_id (uuid, required), user_id (uuid, required),
--     role_key (text, required), effective_from (timestamptz, optional),
--     metadata (jsonb, optional) }
-- Envelope: { ok, branch_membership_id, already_processed, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300400_add_branch_member_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.add_branch_member_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_id UUID;
  v_member_user_id UUID;
  v_role_key TEXT := NULLIF(btrim(lower(COALESCE(p_args->>'role_key', ''))), '');
  v_effective_from TIMESTAMPTZ := COALESCE(NULLIF(p_args->>'effective_from', '')::timestamptz, now());
  v_metadata JSONB := COALESCE(p_args->'metadata', NULL);
  v_branch public.branches%ROWTYPE;
  v_membership_id UUID;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'add_branch_member_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_branch_id := NULLIF(p_args->>'branch_id', '')::uuid;
  v_member_user_id := NULLIF(p_args->>'user_id', '')::uuid;
  IF v_branch_id IS NULL OR v_member_user_id IS NULL OR v_role_key IS NULL THEN
    RAISE EXCEPTION 'add_branch_member_v1 requires branch_id, user_id, role_key' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = v_branch_id;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'add_branch_member_v1 branch % not found', v_branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'add_branch_member_v1 branch % outside tenant scope', v_branch_id USING ERRCODE = '42501';
  END IF;

  -- Idempotent: existing active membership for same (branch, user, role) -> already_processed
  SELECT id INTO v_membership_id
    FROM public.branch_memberships
   WHERE branch_id = v_branch_id
     AND user_id = v_member_user_id
     AND role_key = v_role_key
     AND is_active IS TRUE
   ORDER BY effective_from DESC
   LIMIT 1;

  IF v_membership_id IS NOT NULL THEN
    v_already := TRUE;
  ELSE
    INSERT INTO public.branch_memberships (
      branch_id, user_id, role_key, effective_from, metadata
    ) VALUES (
      v_branch_id, v_member_user_id, v_role_key, v_effective_from, v_metadata
    ) RETURNING id INTO v_membership_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_branch.organization_id, 'branch_membership.added', 'branch_membership', v_membership_id, v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'branch_id', v_branch_id,
        'user_id', v_member_user_id,
        'role_key', v_role_key,
        'effective_from', to_jsonb(v_effective_from)
      )),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.member_add',
    p_resource_type := 'branch_membership',
    p_resource_id := v_membership_id,
    p_decision_point := 'add_branch_member_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_active' ELSE 'added' END,
    p_performed_by_system := 'add_branch_member_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object(
      'branch_id', v_branch_id,
      'user_id', v_member_user_id,
      'role_key', v_role_key
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_membership_id', v_membership_id,
    'already_processed', v_already,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.add_branch_member_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_branch_member_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.add_branch_member_v1(JSONB) IS
  'NETWORK W9 canonical write RPC: insert public.branch_memberships row + decision_log + domain_event. Capability: branches.write. Idempotent on (branch, user, role).';

SELECT pg_advisory_unlock(hashtext('202604300400_add_branch_member_v1'));
COMMIT;
