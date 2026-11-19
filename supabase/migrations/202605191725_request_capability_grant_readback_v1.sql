-- Request capability grant readback contract.
--
-- Console V2 shows same-context access request evidence after
-- request_capability_grant_v1 succeeds. The card must be backed by the
-- capability_grant_requests row, not by values echoed from the modal. This
-- replacement keeps the existing write/audit behavior and returns a
-- request_readback object selected from the persisted row.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605191725_request_capability_grant_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_duration_hours INTEGER := NULLIF(p_args->>'duration_hours', '')::integer;
  v_correlation_id_uuid UUID := gen_random_uuid();
  v_correlation_id TEXT := v_correlation_id_uuid::text;
  v_decision_id UUID := gen_random_uuid();
  v_request_id UUID := gen_random_uuid();
  v_existing_id UUID;
  v_readback JSONB;
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
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'id', r.id,
      'organization_id', r.organization_id,
      'requested_by', r.requested_by,
      'target_user_id', r.target_user_id,
      'capability_key', r.capability_key,
      'scope_type', r.scope_type,
      'scope_id', r.scope_id,
      'reason', r.reason,
      'duration_hours', NULLIF(r.metadata->>'duration_hours', '')::integer,
      'status', r.status,
      'correlation_id', r.correlation_id,
      'decision_log_id', r.decision_log_id,
      'created_at', r.created_at
    ))
      INTO v_readback
      FROM public.capability_grant_requests r
     WHERE r.id = v_existing_id;

    RETURN jsonb_build_object(
      'ok', true,
      'capability_grant_request_id', v_existing_id,
      'idempotent', true,
      'status', v_readback->>'status',
      'correlation_id', v_readback->>'correlation_id',
      'settings_resolution_id', v_readback->>'decision_log_id',
      'request_readback', v_readback
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
      'requested_at', now(),
      'duration_hours', v_duration_hours
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
    jsonb_strip_nulls(jsonb_build_object(
      'capability_key', v_capability_key,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'target_user_id', v_target_user,
      'duration_hours', v_duration_hours
    )),
    v_reason, 'request_capability_grant_v1', v_correlation_id_uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_org_id, 'capability_grant_request.created',
    'capability_grant_request', v_request_id,
    jsonb_strip_nulls(jsonb_build_object(
      'capability_key', v_capability_key,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'target_user_id', v_target_user,
      'duration_hours', v_duration_hours
    )),
    v_correlation_id_uuid, 'pending'
  );

  SELECT jsonb_strip_nulls(jsonb_build_object(
    'id', r.id,
    'organization_id', r.organization_id,
    'requested_by', r.requested_by,
    'target_user_id', r.target_user_id,
    'capability_key', r.capability_key,
    'scope_type', r.scope_type,
    'scope_id', r.scope_id,
    'reason', r.reason,
    'duration_hours', NULLIF(r.metadata->>'duration_hours', '')::integer,
    'status', r.status,
    'correlation_id', r.correlation_id,
    'decision_log_id', r.decision_log_id,
    'created_at', r.created_at
  ))
    INTO v_readback
    FROM public.capability_grant_requests r
   WHERE r.id = v_request_id;

  RETURN jsonb_build_object(
    'ok', true,
    'capability_grant_request_id', v_request_id,
    'idempotent', false,
    'status', v_readback->>'status',
    'correlation_id', v_readback->>'correlation_id',
    'settings_resolution_id', v_decision_id,
    'request_readback', v_readback
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_capability_grant_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_capability_grant_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_capability_grant_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.request_capability_grant_v1(jsonb)
  IS 'Canonical write RPC: append capability_grant_requests row + audit and return persisted request_readback. Capability: access_policy.request.';

SELECT pg_advisory_unlock(hashtext('202605191725_request_capability_grant_readback_v1'));

COMMIT;
