-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: update_support_case_v1
-- Date: 2026-04-27
--
-- Purpose:
--   Canonical RPC to edit a support case's editable attributes (subject, priority,
--   channel, status_reason, sla_minutes, metadata). status changes are NOT done
--   here — they go through the dedicated lifecycle RPCs (assign/resolve/reopen).
--
-- Args (jsonb p_args):
--   support_case_id   uuid (required)
--   subject           text (optional)
--   priority          text (optional)
--   channel           text (optional)
--   status_reason     text (optional)
--   sla_minutes       int  (optional; nullable to clear)
--   metadata_patch    jsonb (optional; merged into existing metadata)
--   correlation_id    uuid (optional; passed through to events)
--
-- Returns: { ok, support_case_id, correlation_id, settings_resolution_id, version }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271221_update_support_case_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.update_support_case_v1(p_args JSONB)
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
  v_subject TEXT;
  v_priority TEXT;
  v_channel TEXT;
  v_status_reason TEXT;
  v_sla_minutes INT;
  v_clear_sla BOOLEAN := FALSE;
  v_sla_due_at TIMESTAMPTZ;
  v_metadata_patch JSONB;
  v_new_metadata JSONB;
  v_new_version INT;
  v_correlation_id UUID;
  v_resolution RECORD;
  v_settings_resolution_id UUID;
  v_changed_fields JSONB := '{}'::jsonb;
BEGIN
  -- 1) Capability gate.
  PERFORM public.assert_capability_v1('support.write');

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'update_support_case_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- 2) Resolve target case (with org-match enforcement via RLS-equivalent guard).
  BEGIN
    v_case_id := NULLIF(v_args->>'support_case_id', '')::UUID;
  EXCEPTION WHEN others THEN
    v_case_id := NULL;
  END;
  IF v_case_id IS NULL THEN
    RAISE EXCEPTION 'update_support_case_v1 requires support_case_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_case FROM public.support_cases WHERE id = v_case_id LIMIT 1;
  IF v_case.id IS NULL THEN
    RAISE EXCEPTION 'update_support_case_v1: support_case % not found', v_case_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT public.is_platform_user() AND v_case.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'update_support_case_v1: cross-tenant access denied'
      USING ERRCODE = '42501';
  END IF;

  -- 3) Parse optional updates.
  IF v_args ? 'subject' THEN
    v_subject := NULLIF(btrim(COALESCE(v_args->>'subject', '')), '');
    v_changed_fields := jsonb_set(v_changed_fields, ARRAY['subject'], to_jsonb(v_subject), TRUE);
  END IF;
  IF v_args ? 'priority' THEN
    v_priority := lower(NULLIF(btrim(COALESCE(v_args->>'priority', '')), ''));
    IF v_priority IS NULL THEN
      RAISE EXCEPTION 'update_support_case_v1: priority cannot be empty'
        USING ERRCODE = '23514';
    END IF;
    v_changed_fields := jsonb_set(v_changed_fields, ARRAY['priority'], to_jsonb(v_priority), TRUE);
  END IF;
  IF v_args ? 'channel' THEN
    v_channel := lower(NULLIF(btrim(COALESCE(v_args->>'channel', '')), ''));
    v_changed_fields := jsonb_set(v_changed_fields, ARRAY['channel'], to_jsonb(v_channel), TRUE);
  END IF;
  IF v_args ? 'status_reason' THEN
    v_status_reason := NULLIF(btrim(COALESCE(v_args->>'status_reason', '')), '');
    v_changed_fields := jsonb_set(v_changed_fields, ARRAY['status_reason'], to_jsonb(v_status_reason), TRUE);
  END IF;
  IF v_args ? 'sla_minutes' THEN
    IF v_args->>'sla_minutes' IS NULL OR btrim(v_args->>'sla_minutes') = '' THEN
      v_clear_sla := TRUE;
    ELSE
      BEGIN v_sla_minutes := NULLIF(v_args->>'sla_minutes', '')::INT;
      EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;
      IF v_sla_minutes IS NOT NULL AND v_sla_minutes <= 0 THEN
        RAISE EXCEPTION 'update_support_case_v1 sla_minutes must be positive'
          USING ERRCODE = '23514';
      END IF;
      IF v_sla_minutes IS NOT NULL THEN
        v_sla_due_at := COALESCE(v_case.opened_at, v_case.created_at) + make_interval(mins => v_sla_minutes);
      END IF;
    END IF;
    v_changed_fields := jsonb_set(v_changed_fields, ARRAY['sla_minutes'], to_jsonb(v_sla_minutes), TRUE);
  END IF;
  v_metadata_patch := COALESCE(v_args->'metadata_patch', '{}'::jsonb);
  IF jsonb_typeof(v_metadata_patch) IS DISTINCT FROM 'object' THEN
    v_metadata_patch := '{}'::jsonb;
  END IF;
  v_new_metadata := COALESCE(v_case.metadata, '{}'::jsonb) || v_metadata_patch;

  BEGIN
    v_correlation_id := NULLIF(v_args->>'correlation_id', '')::UUID;
  EXCEPTION WHEN others THEN v_correlation_id := NULL; END;
  IF v_correlation_id IS NULL THEN
    v_correlation_id := gen_random_uuid();
  END IF;

  -- 4) Resolve settings ladder for evidence.
  BEGIN
    SELECT *
      INTO v_resolution
      FROM public.resolve_settings_row_from_context(
        'support_case_policy',
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_case.organization_id,
          'tenant_id', v_case.organization_id,
          'client_id', v_case.client_id,
          'sender_id', v_case.sender_id
        ))
      ) LIMIT 1;
  EXCEPTION WHEN others THEN
    v_resolution := NULL;
  END;
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
      p_inputs => jsonb_build_object('action', 'update_support_case')
    );
  END IF;

  -- 5) Apply update (only the fields the caller explicitly requested).
  v_new_version := v_case.version + 1;

  UPDATE public.support_cases
     SET subject       = CASE WHEN v_args ? 'subject'       THEN v_subject       ELSE subject       END,
         priority      = CASE WHEN v_args ? 'priority'      THEN v_priority      ELSE priority      END,
         channel       = CASE WHEN v_args ? 'channel'       THEN v_channel       ELSE channel       END,
         status_reason = CASE WHEN v_args ? 'status_reason' THEN v_status_reason ELSE status_reason END,
         sla_minutes   = CASE WHEN v_args ? 'sla_minutes' AND v_clear_sla THEN NULL
                              WHEN v_args ? 'sla_minutes'                THEN v_sla_minutes
                              ELSE sla_minutes END,
         sla_due_at    = CASE WHEN v_args ? 'sla_minutes' AND v_clear_sla THEN NULL
                              WHEN v_args ? 'sla_minutes'                THEN v_sla_due_at
                              ELSE sla_due_at END,
         metadata      = v_new_metadata,
         version       = v_new_version,
         updated_at    = now()
   WHERE id = v_case_id;

  -- 6) Append immutable case event.
  INSERT INTO public.support_case_events (
    support_case_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, case_version, settings_resolution_id
  ) VALUES (
    v_case_id, v_case.organization_id,
    'support_case.updated', v_case.status, v_case.status,
    v_user_id,
    jsonb_build_object('changed_fields', v_changed_fields),
    v_new_version, v_settings_resolution_id
  );

  -- 7) Emit engine-first domain event.
  PERFORM public.enqueue_domain_event(
    p_organization_id => v_case.organization_id,
    p_event_type => 'support_case.updated',
    p_resource_type => 'support_case',
    p_resource_id => v_case_id,
    p_payload => jsonb_build_object(
      'support_case_id', v_case_id,
      'changed_fields', v_changed_fields
    ),
    p_correlation_id => v_correlation_id
  );

  -- 8) Decision log row.
  PERFORM public.log_decision(
    p_organization_id => v_case.organization_id,
    p_decision_category => 'support_case.update',
    p_resource_type => 'support_case',
    p_resource_id => v_case_id,
    p_decision_point => 'update',
    p_decision_outcome => 'updated',
    p_performed_by_system => 'update_support_case_v1',
    p_correlation_id => v_correlation_id,
    p_decision_inputs => jsonb_build_object('changed_fields', v_changed_fields),
    p_settings_resolution_id => v_settings_resolution_id
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id,
    'version', v_new_version
  );
END;
$function$;

COMMENT ON FUNCTION public.update_support_case_v1(JSONB)
  IS 'Canonical RPC to edit a support case (subject/priority/channel/status_reason/sla_minutes/metadata). Status transitions go through dedicated lifecycle RPCs.';

REVOKE ALL ON FUNCTION public.update_support_case_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_support_case_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_support_case_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604271221_update_support_case_v1'));
COMMIT;
