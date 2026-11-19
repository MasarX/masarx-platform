-- Spec-Issue: Phase B1 - Platform RPC contract: request_capability_grant_v1
-- Step: B1-RPC-15
-- Capability: access_policy.request
-- Replace PREVIEW: append capability_grant_requests row + emit canonical
-- audit (decision_log + domain_events). Manual review workflow connection
-- left to future ladder (manual_review_task_id nullable for now).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280150_request_capability_grant_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.request_capability_grant_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_capability_key TEXT := NULLIF(btrim(p_args->>'capability_key'), '');
  v_scope_type TEXT := COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'tenant');
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(p_args->>'reason'), '');
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_request_id UUID := gen_random_uuid();
  v_existing_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_capability_grant_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.request');

  IF v_capability_key IS NULL THEN
    RAISE EXCEPTION 'request_capability_grant_v1 requires capability_key'
      USING ERRCODE = '23502';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'request_capability_grant_v1 requires reason for audit trail'
      USING ERRCODE = '23502';
  END IF;

  IF v_scope_type NOT IN ('global','platform','tenant','client','sender','source') THEN
    RAISE EXCEPTION 'request_capability_grant_v1 invalid scope_type %', v_scope_type
      USING ERRCODE = '22023';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'request_capability_grant_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotency: collapse duplicate pending request for same target+capability+scope
  SELECT id INTO v_existing_id
    FROM public.capability_grant_requests
   WHERE organization_id = v_org_id
     AND COALESCE(target_user_id, requested_by) = COALESCE(v_target_user, v_user_id)
     AND capability_key = v_capability_key
     AND scope_type = v_scope_type
     AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'capability_grant_request_id', v_existing_id,
      'idempotent', true,
      'status', 'pending',
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id
    );
  END IF;

  INSERT INTO public.capability_grant_requests (
    id, organization_id, requested_by, target_user_id,
    capability_key, scope_type, scope_id, reason, status,
    correlation_id, decision_log_id, settings_resolution_id, metadata
  ) VALUES (
    v_request_id, v_org_id, v_user_id, COALESCE(v_target_user, v_user_id),
    v_capability_key, v_scope_type, v_scope_id, v_reason, 'pending',
    v_correlation_id, v_decision_id, NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'requested_via', 'request_capability_grant_v1',
      'requested_at', now()
    ))
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, decision_reason,
    performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_org_id, 'access_policy.request',
    'capability_grant_request', v_request_id,
    'request_capability_grant_v1', 'pending',
    jsonb_build_object(
      'capability_key', v_capability_key,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'target_user_id', v_target_user
    ),
    v_reason, 'request_capability_grant_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_org_id, 'capability_grant_request.created',
    'capability_grant_request', v_request_id,
    jsonb_build_object(
      'capability_key', v_capability_key,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'target_user_id', v_target_user
    ),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'capability_grant_request_id', v_request_id,
    'idempotent', false,
    'status', 'pending',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_capability_grant_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_capability_grant_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_capability_grant_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.request_capability_grant_v1(jsonb)
  IS 'Canonical write RPC: append capability_grant_requests row + audit. Replaces PREVIEW stub. Capability: access_policy.request.';

SELECT pg_advisory_unlock(hashtext('202604280150_request_capability_grant_v1'));
COMMIT;
