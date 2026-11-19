-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: resolve_support_case_v1
-- Date: 2026-04-27
--
-- Purpose:
--   Canonical RPC to close a support case with a resolution reason. Sets status to
--   'resolved' (and resolved_at = now()); FE/automation drives separate 'closed'
--   transition if needed (workflow-driven). Idempotent for already-resolved cases.
--
-- Args (jsonb p_args):
--   support_case_id   uuid (required)
--   resolution        text (optional; stored in metadata.resolution + status_reason)
--   close             boolean (optional; if true also sets status='closed', closed_at=now())
--   correlation_id    uuid (optional)
--
-- Returns: { ok, support_case_id, status, version, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271224_resolve_support_case_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_support_case_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_case_id UUID;
  v_case RECORD;
  v_resolution_text TEXT;
  v_close BOOLEAN := FALSE;
  v_to_status TEXT;
  v_correlation_id UUID;
  v_resolution RECORD;
  v_settings_resolution_id UUID;
  v_new_version INT;
  v_already BOOLEAN := FALSE;
BEGIN
  PERFORM public.assert_capability_v1('support.write');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_support_case_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  BEGIN v_case_id := NULLIF(v_args->>'support_case_id', '')::UUID;
  EXCEPTION WHEN others THEN v_case_id := NULL; END;
  IF v_case_id IS NULL THEN
    RAISE EXCEPTION 'resolve_support_case_v1 requires support_case_id' USING ERRCODE = '23502';
  END IF;

  v_resolution_text := NULLIF(btrim(COALESCE(v_args->>'resolution', '')), '');
  v_close := COALESCE((v_args->>'close')::boolean, FALSE);

  SELECT * INTO v_case FROM public.support_cases WHERE id = v_case_id LIMIT 1;
  IF v_case.id IS NULL THEN
    RAISE EXCEPTION 'resolve_support_case_v1: support_case % not found', v_case_id USING ERRCODE = '23503';
  END IF;
  IF NOT public.is_platform_user() AND v_case.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'resolve_support_case_v1: cross-tenant access denied' USING ERRCODE = '42501';
  END IF;

  v_to_status := CASE WHEN v_close THEN 'closed' ELSE 'resolved' END;

  -- Idempotency: terminal status already set
  IF v_case.status = v_to_status OR (v_case.status IN ('resolved', 'closed') AND NOT v_close) THEN
    v_already := TRUE;
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
      p_inputs => jsonb_build_object('action', 'resolve_support_case', 'close', v_close)
    );
  END IF;

  IF NOT v_already THEN
    v_new_version := v_case.version + 1;
    UPDATE public.support_cases
       SET status = v_to_status,
           status_reason = COALESCE(v_resolution_text, status_reason),
           resolved_at = COALESCE(resolved_at, now()),
           closed_at = CASE WHEN v_close THEN now() ELSE closed_at END,
           metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_strip_nulls(jsonb_build_object('resolution', v_resolution_text)),
           version = v_new_version,
           updated_at = now()
     WHERE id = v_case_id;

    INSERT INTO public.support_case_events (
      support_case_id, organization_id, event_type, from_status, to_status,
      actor_user_id, payload, case_version, settings_resolution_id
    ) VALUES (
      v_case_id, v_case.organization_id,
      CASE WHEN v_close THEN 'support_case.closed' ELSE 'support_case.resolved' END,
      v_case.status, v_to_status,
      v_user_id,
      jsonb_strip_nulls(jsonb_build_object('resolution', v_resolution_text, 'close', v_close)),
      v_new_version, v_settings_resolution_id
    );

    PERFORM public.enqueue_domain_event(
      p_organization_id => v_case.organization_id,
      p_event_type => CASE WHEN v_close THEN 'support_case.closed' ELSE 'support_case.resolved' END,
      p_resource_type => 'support_case',
      p_resource_id => v_case_id,
      p_payload => jsonb_strip_nulls(jsonb_build_object(
        'support_case_id', v_case_id,
        'resolution', v_resolution_text,
        'from_status', v_case.status,
        'to_status', v_to_status
      )),
      p_correlation_id => v_correlation_id
    );

    PERFORM public.log_decision(
      p_organization_id => v_case.organization_id,
      p_decision_category => 'support_case.resolve',
      p_resource_type => 'support_case',
      p_resource_id => v_case_id,
      p_decision_point => 'resolve',
      p_decision_outcome => v_to_status,
      p_performed_by_system => 'resolve_support_case_v1',
      p_correlation_id => v_correlation_id,
      p_decision_inputs => jsonb_strip_nulls(jsonb_build_object(
        'resolution', v_resolution_text,
        'from_status', v_case.status,
        'to_status', v_to_status
      )),
      p_settings_resolution_id => v_settings_resolution_id
    );
  ELSE
    v_new_version := v_case.version;
    v_to_status := v_case.status;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case_id,
    'status', v_to_status,
    'version', v_new_version,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id,
    'already_processed', CASE WHEN v_already THEN TRUE ELSE NULL END
  ));
END;
$function$;

COMMENT ON FUNCTION public.resolve_support_case_v1(JSONB)
  IS 'Canonical RPC to resolve (or close) a support case. Capability-gated; idempotent for terminal status.';

REVOKE ALL ON FUNCTION public.resolve_support_case_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_support_case_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_support_case_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604271224_resolve_support_case_v1'));
COMMIT;
