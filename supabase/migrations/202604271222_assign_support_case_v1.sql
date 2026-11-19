-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: assign_support_case_v1
-- Date: 2026-04-27
--
-- Purpose:
--   Canonical RPC to set support_cases.assigned_to. Capability-gated, ladder-resolved,
--   emits domain_event + decision_log. Idempotent for the same target.
--
-- Args (jsonb p_args):
--   support_case_id   uuid (required)
--   assigned_to       uuid|null (required; null = unassign)
--   correlation_id    uuid (optional)
--
-- Returns: { ok, support_case_id, assigned_to, version, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271222_assign_support_case_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.assign_support_case_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_case_id UUID;
  v_assignee UUID;
  v_unassign BOOLEAN := FALSE;
  v_case RECORD;
  v_assignee_org UUID;
  v_correlation_id UUID;
  v_resolution RECORD;
  v_settings_resolution_id UUID;
  v_new_version INT;
  v_already_assigned BOOLEAN := FALSE;
BEGIN
  PERFORM public.assert_capability_v1('support.write');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'assign_support_case_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  BEGIN v_case_id := NULLIF(v_args->>'support_case_id', '')::UUID;
  EXCEPTION WHEN others THEN v_case_id := NULL; END;
  IF v_case_id IS NULL THEN
    RAISE EXCEPTION 'assign_support_case_v1 requires support_case_id' USING ERRCODE = '23502';
  END IF;

  IF NOT (v_args ? 'assigned_to') THEN
    RAISE EXCEPTION 'assign_support_case_v1 requires assigned_to (use null to unassign)'
      USING ERRCODE = '23502';
  END IF;

  IF v_args->>'assigned_to' IS NULL OR btrim(v_args->>'assigned_to') = '' THEN
    v_unassign := TRUE;
    v_assignee := NULL;
  ELSE
    BEGIN v_assignee := NULLIF(v_args->>'assigned_to', '')::UUID;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'assign_support_case_v1: invalid assigned_to uuid' USING ERRCODE = '22P02';
    END;
  END IF;

  SELECT * INTO v_case FROM public.support_cases WHERE id = v_case_id LIMIT 1;
  IF v_case.id IS NULL THEN
    RAISE EXCEPTION 'assign_support_case_v1: support_case % not found', v_case_id USING ERRCODE = '23503';
  END IF;
  IF NOT public.is_platform_user() AND v_case.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'assign_support_case_v1: cross-tenant access denied' USING ERRCODE = '42501';
  END IF;

  IF v_assignee IS NOT NULL THEN
    SELECT u.organization_id INTO v_assignee_org FROM public.users u WHERE u.id = v_assignee;
    IF v_assignee_org IS NULL THEN
      RAISE EXCEPTION 'assign_support_case_v1: assignee % not found', v_assignee USING ERRCODE = '23503';
    END IF;
    IF v_assignee_org <> v_case.organization_id THEN
      RAISE EXCEPTION 'assign_support_case_v1: assignee organization mismatch'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Idempotency: same assignee already set
  IF v_case.assigned_to IS NOT DISTINCT FROM v_assignee THEN
    v_already_assigned := TRUE;
  END IF;

  BEGIN v_correlation_id := NULLIF(v_args->>'correlation_id', '')::UUID;
  EXCEPTION WHEN others THEN v_correlation_id := NULL; END;
  IF v_correlation_id IS NULL THEN v_correlation_id := gen_random_uuid(); END IF;

  -- Settings resolution
  BEGIN
    SELECT * INTO v_resolution
      FROM public.resolve_settings_row_from_context(
        'support_case_policy',
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_case.organization_id,
          'tenant_id', v_case.organization_id,
          'client_id', v_case.client_id,
          'sender_id', v_case.sender_id
        ))) LIMIT 1;
  EXCEPTION WHEN others THEN v_resolution := NULL; END;
  IF v_resolution.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id => v_case.organization_id,
      p_category => 'support_case_policy',
      p_winning_scope_type => v_resolution.scope_type,
      p_winning_scope_id => v_resolution.scope_id,
      p_winning_settings_id => v_resolution.settings_id,
      p_winning_settings_version_id => v_resolution.settings_version_id,
      p_winning_version => v_resolution.version,
      p_scope_path => COALESCE(v_resolution.scope_path, '[]'::jsonb),
      p_inputs => jsonb_build_object('action', CASE WHEN v_unassign THEN 'unassign' ELSE 'assign' END)
    );
  END IF;

  IF NOT v_already_assigned THEN
    v_new_version := v_case.version + 1;
    UPDATE public.support_cases
       SET assigned_to = v_assignee,
           assigned_at = CASE WHEN v_assignee IS NOT NULL THEN now() ELSE NULL END,
           version = v_new_version,
           updated_at = now()
     WHERE id = v_case_id;

    INSERT INTO public.support_case_events (
      support_case_id, organization_id, event_type, from_status, to_status,
      actor_user_id, payload, case_version, settings_resolution_id
    ) VALUES (
      v_case_id, v_case.organization_id,
      CASE WHEN v_unassign THEN 'support_case.unassigned' ELSE 'support_case.assigned' END,
      v_case.status, v_case.status,
      v_user_id,
      jsonb_strip_nulls(jsonb_build_object(
        'previous_assignee', v_case.assigned_to,
        'assigned_to', v_assignee
      )),
      v_new_version, v_settings_resolution_id
    );

    PERFORM public.enqueue_domain_event(
      p_organization_id => v_case.organization_id,
      p_event_type => CASE WHEN v_unassign THEN 'support_case.unassigned' ELSE 'support_case.assigned' END,
      p_resource_type => 'support_case',
      p_resource_id => v_case_id,
      p_payload => jsonb_strip_nulls(jsonb_build_object(
        'support_case_id', v_case_id,
        'assigned_to', v_assignee,
        'previous_assignee', v_case.assigned_to
      )),
      p_correlation_id => v_correlation_id
    );

    PERFORM public.log_decision(
      p_organization_id => v_case.organization_id,
      p_decision_category => 'support_case.assign',
      p_resource_type => 'support_case',
      p_resource_id => v_case_id,
      p_decision_point => 'assign',
      p_decision_outcome => CASE WHEN v_unassign THEN 'unassigned' ELSE 'assigned' END,
      p_performed_by_system => 'assign_support_case_v1',
      p_correlation_id => v_correlation_id,
      p_decision_inputs => jsonb_strip_nulls(jsonb_build_object(
        'previous_assignee', v_case.assigned_to,
        'assigned_to', v_assignee
      )),
      p_settings_resolution_id => v_settings_resolution_id
    );
  ELSE
    v_new_version := v_case.version;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case_id,
    'assigned_to', v_assignee,
    'version', v_new_version,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id,
    'already_processed', CASE WHEN v_already_assigned THEN TRUE ELSE NULL END
  ));
END;
$function$;

COMMENT ON FUNCTION public.assign_support_case_v1(JSONB)
  IS 'Canonical RPC to assign (or unassign) a support case to a user. Capability-gated; idempotent for same target.';

REVOKE ALL ON FUNCTION public.assign_support_case_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_support_case_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_support_case_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604271222_assign_support_case_v1'));
COMMIT;
