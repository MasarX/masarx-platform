-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: send_support_message_v1
-- Date: 2026-04-27
--
-- Purpose:
--   Append a message to a support case. Inserts into support_messages (immutable
--   ledger). Capability-gated; org-scoped; lookup-validated direction + channel.
--
-- Args (jsonb p_args):
--   support_case_id   uuid (required)
--   direction         text (required; lookup support_message_direction)
--   channel           text (required; lookup support_message_channel)
--   body              text (optional; required when artifact_id is null)
--   artifact_id       uuid (optional)
--   metadata          jsonb (optional)
--   correlation_id    uuid (optional)
--
-- Returns: { ok, support_case_id, support_message_id, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271227_send_support_message_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.send_support_message_v1(p_args JSONB)
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
  v_direction TEXT;
  v_channel TEXT;
  v_body TEXT;
  v_artifact_id UUID;
  v_metadata JSONB;
  v_correlation_id UUID;
  v_msg_id UUID := gen_random_uuid();
  v_resolution RECORD;
  v_settings_resolution_id UUID;
BEGIN
  PERFORM public.assert_capability_v1('support.write');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'send_support_message_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  BEGIN v_case_id := NULLIF(v_args->>'support_case_id', '')::UUID;
  EXCEPTION WHEN others THEN v_case_id := NULL; END;
  IF v_case_id IS NULL THEN
    RAISE EXCEPTION 'send_support_message_v1 requires support_case_id' USING ERRCODE = '23502';
  END IF;

  v_direction := lower(NULLIF(btrim(COALESCE(v_args->>'direction', '')), ''));
  v_channel := lower(NULLIF(btrim(COALESCE(v_args->>'channel', '')), ''));
  IF v_direction IS NULL THEN
    RAISE EXCEPTION 'send_support_message_v1 requires direction' USING ERRCODE = '23502';
  END IF;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'send_support_message_v1 requires channel' USING ERRCODE = '23502';
  END IF;

  v_body := NULLIF(btrim(COALESCE(v_args->>'body', '')), '');
  BEGIN v_artifact_id := NULLIF(v_args->>'artifact_id', '')::UUID;
  EXCEPTION WHEN others THEN v_artifact_id := NULL; END;

  IF v_body IS NULL AND v_artifact_id IS NULL THEN
    RAISE EXCEPTION 'send_support_message_v1 requires body or artifact_id'
      USING ERRCODE = '23514';
  END IF;

  v_metadata := COALESCE(v_args->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT * INTO v_case FROM public.support_cases WHERE id = v_case_id LIMIT 1;
  IF v_case.id IS NULL THEN
    RAISE EXCEPTION 'send_support_message_v1: support_case % not found', v_case_id USING ERRCODE = '23503';
  END IF;
  IF NOT public.is_platform_user() AND v_case.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'send_support_message_v1: cross-tenant access denied' USING ERRCODE = '42501';
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
      p_inputs => jsonb_build_object('action', 'send_support_message', 'direction', v_direction, 'channel', v_channel)
    );
  END IF;

  -- Insert into ledger (lookup_column_contracts validate direction/channel via FK enforcement).
  INSERT INTO public.support_messages (
    id, support_case_id, organization_id,
    direction, channel,
    actor_user_id, body, artifact_id, metadata
  ) VALUES (
    v_msg_id, v_case_id, v_case.organization_id,
    v_direction, v_channel,
    v_user_id, v_body, v_artifact_id, v_metadata
  );

  -- Append case event marking the new message
  INSERT INTO public.support_case_events (
    support_case_id, organization_id, event_type, from_status, to_status,
    actor_user_id, payload, case_version, settings_resolution_id
  ) VALUES (
    v_case_id, v_case.organization_id,
    'support_case.message_sent', v_case.status, v_case.status,
    v_user_id,
    jsonb_strip_nulls(jsonb_build_object(
      'support_message_id', v_msg_id,
      'direction', v_direction,
      'channel', v_channel,
      'has_body', v_body IS NOT NULL,
      'artifact_id', v_artifact_id
    )),
    v_case.version, v_settings_resolution_id
  );

  PERFORM public.enqueue_domain_event(
    p_organization_id => v_case.organization_id,
    p_event_type => 'support_case.message_sent',
    p_resource_type => 'support_case',
    p_resource_id => v_case_id,
    p_payload => jsonb_strip_nulls(jsonb_build_object(
      'support_case_id', v_case_id,
      'support_message_id', v_msg_id,
      'direction', v_direction,
      'channel', v_channel
    )),
    p_correlation_id => v_correlation_id
  );

  PERFORM public.log_decision(
    p_organization_id => v_case.organization_id,
    p_decision_category => 'support_case.message',
    p_resource_type => 'support_case',
    p_resource_id => v_case_id,
    p_decision_point => 'send_message',
    p_decision_outcome => 'sent',
    p_performed_by_system => 'send_support_message_v1',
    p_correlation_id => v_correlation_id,
    p_decision_inputs => jsonb_strip_nulls(jsonb_build_object(
      'support_message_id', v_msg_id,
      'direction', v_direction,
      'channel', v_channel
    )),
    p_settings_resolution_id => v_settings_resolution_id
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case_id,
    'support_message_id', v_msg_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id
  );
END;
$function$;

COMMENT ON FUNCTION public.send_support_message_v1(JSONB)
  IS 'Canonical RPC to append a message to a support case. Capability-gated; lookup-validated direction + channel.';

REVOKE ALL ON FUNCTION public.send_support_message_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.send_support_message_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.send_support_message_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604271227_send_support_message_v1'));
COMMIT;
