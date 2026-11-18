-- Spec-Issue: NETWORK W9 — close residual gaps on branches/zones canonical write RPCs
-- Step: W9-S02
-- Migration: remove_branch_member_v1
-- Capability: branches.write
-- Date: 2026-04-30
--
-- Purpose:
--   Canonical write RPC: deactivate public.branch_memberships row + decision_log + domain_event.
--   Replaces the FE phaseC6Rpc shim path (NETWORK gap closure).
--
-- Args (jsonb):
--   { membership_id (uuid, required), reason (text, optional), metadata (jsonb, optional) }
-- Envelope: { ok, branch_membership_id, already_processed, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300410_remove_branch_member_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.remove_branch_member_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_membership_id UUID;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_metadata JSONB := COALESCE(p_args->'metadata', NULL);
  v_membership public.branch_memberships%ROWTYPE;
  v_branch public.branches%ROWTYPE;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'remove_branch_member_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_membership_id := NULLIF(p_args->>'membership_id', '')::uuid;
  IF v_membership_id IS NULL THEN
    RAISE EXCEPTION 'remove_branch_member_v1 requires membership_id' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_membership FROM public.branch_memberships WHERE id = v_membership_id FOR UPDATE;
  IF v_membership.id IS NULL THEN
    RAISE EXCEPTION 'remove_branch_member_v1 membership % not found', v_membership_id USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = v_membership.branch_id;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'remove_branch_member_v1 branch % not found', v_membership.branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'remove_branch_member_v1 branch % outside tenant scope', v_membership.branch_id USING ERRCODE = '42501';
  END IF;

  IF v_membership.is_active IS FALSE THEN
    v_already := TRUE;
  ELSE
    UPDATE public.branch_memberships
       SET is_active = FALSE,
           effective_to = COALESCE(effective_to, now()),
           metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_strip_nulls(jsonb_build_object(
                        'removed_at', to_jsonb(now()),
                        'removed_by_user_id', to_jsonb(v_user_id),
                        'removed_reason', v_reason
                      )),
           updated_at = now()
     WHERE id = v_membership_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_branch.organization_id, 'branch_membership.removed', 'branch_membership', v_membership_id, v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'branch_id', v_membership.branch_id,
        'user_id', v_membership.user_id,
        'role_key', v_membership.role_key,
        'reason', v_reason,
        'metadata', v_metadata
      )),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.member_remove',
    p_resource_type := 'branch_membership',
    p_resource_id := v_membership_id,
    p_decision_point := 'remove_branch_member_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_inactive' ELSE 'removed' END,
    p_performed_by_system := 'remove_branch_member_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'membership_id', v_membership_id,
      'reason', v_reason
    )),
    p_decision_reason := COALESCE(v_reason, 'remove_branch_member_no_reason')
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

REVOKE ALL ON FUNCTION public.remove_branch_member_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_branch_member_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.remove_branch_member_v1(JSONB) IS
  'NETWORK W9 canonical write RPC: deactivate public.branch_memberships row + decision_log + domain_event. Capability: branches.write. Idempotent.';

SELECT pg_advisory_unlock(hashtext('202604300410_remove_branch_member_v1'));
COMMIT;
