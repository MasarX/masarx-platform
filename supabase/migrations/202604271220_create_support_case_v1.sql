-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: create_support_case_v1
-- Date: 2026-04-27
--
-- Purpose:
--   Canonical write RPC to create a support case. Capability-gated, ladder-resolved,
--   emits domain_event + decision_log row. No hardcoded role/branching.
--
-- Args (jsonb p_args):
--   organization_id   uuid (optional; defaults to current_user_org_id)
--   client_id         uuid (optional)
--   sender_id         uuid (optional)
--   subject           text (optional)
--   priority          text (optional, default 'medium')
--   channel           text (optional)
--   resource_type     text (optional)
--   resource_id       uuid (optional)
--   sla_minutes       int  (optional)
--   metadata          jsonb (optional)
--   idempotency_key   text (optional)
--
-- Returns: { ok, support_case_id, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271220_create_support_case_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.create_support_case_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
  v_subject TEXT;
  v_priority TEXT;
  v_channel TEXT;
  v_resource_type TEXT;
  v_resource_id UUID;
  v_sla_minutes INT;
  v_sla_due_at TIMESTAMPTZ;
  v_metadata JSONB;
  v_idempotency_key TEXT;
  v_existing_id UUID;
  v_case_id UUID;
  v_correlation_id UUID := gen_random_uuid();
  v_resolution RECORD;
  v_settings_resolution_id UUID;
BEGIN
  -- 1) Capability gate (raises 42501 / capability_denied if missing).
  PERFORM public.assert_capability_v1('support.write');

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_support_case_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- 2) Resolve organization (default to current user's org; never widen).
  BEGIN
    v_org_id := NULLIF(v_args->>'organization_id', '')::UUID;
  EXCEPTION WHEN others THEN
    v_org_id := NULL;
  END;
  IF v_org_id IS NULL THEN
    v_org_id := public.current_user_org_id();
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_support_case_v1 could not resolve organization_id'
      USING ERRCODE = '23514';
  END IF;
  IF NOT public.is_platform_user() AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'create_support_case_v1 cannot target another organization'
      USING ERRCODE = '42501';
  END IF;

  -- 3) Optional scope context.
  BEGIN v_client_id := NULLIF(v_args->>'client_id', '')::UUID;
  EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_args->>'sender_id', '')::UUID;
  EXCEPTION WHEN others THEN v_sender_id := NULL; END;
  BEGIN v_resource_id := NULLIF(v_args->>'resource_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;

  v_subject := NULLIF(btrim(COALESCE(v_args->>'subject', '')), '');
  v_priority := lower(NULLIF(btrim(COALESCE(v_args->>'priority', '')), ''));
  IF v_priority IS NULL THEN
    v_priority := 'medium';
  END IF;
  v_channel := lower(NULLIF(btrim(COALESCE(v_args->>'channel', '')), ''));
  v_resource_type := lower(NULLIF(btrim(COALESCE(v_args->>'resource_type', '')), ''));

  BEGIN v_sla_minutes := NULLIF(v_args->>'sla_minutes', '')::INT;
  EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;
  IF v_sla_minutes IS NOT NULL AND v_sla_minutes <= 0 THEN
    RAISE EXCEPTION 'create_support_case_v1 sla_minutes must be positive'
      USING ERRCODE = '23514';
  END IF;
  IF v_sla_minutes IS NOT NULL THEN
    v_sla_due_at := now() + make_interval(mins => v_sla_minutes);
  END IF;

  v_metadata := COALESCE(v_args->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), '');

  -- 4) Resolve settings ladder (override-ladder evidence).
  --    support_case_policy is the configured category; if absent, ladder still resolves to NULL row.
  BEGIN
    SELECT *
      INTO v_resolution
      FROM public.resolve_settings_row_from_context(
        'support_case_policy',
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org_id,
          'tenant_id', v_org_id,
          'client_id', v_client_id,
          'sender_id', v_sender_id
        ))
      )
     LIMIT 1;
  EXCEPTION WHEN others THEN
    v_resolution := NULL;
  END;

  IF v_resolution.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id => v_org_id,
      p_category => 'support_case_policy',
      p_winning_scope_type => v_resolution.scope_type,
      p_winning_scope_id => v_resolution.scope_id,
      p_winning_settings_id => v_resolution.settings_id,
      p_winning_settings_version_id => v_resolution.settings_version_id,
      p_winning_version => v_resolution.version,
      p_scope_path => COALESCE(v_resolution.scope_path, '[]'::jsonb),
      p_inputs => jsonb_build_object('action', 'create_support_case')
    );
  END IF;

  -- 5) Idempotency: short-circuit if same key already used in this org.
  IF v_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id
      FROM public.support_cases
     WHERE organization_id = v_org_id
       AND idempotency_key = v_idempotency_key
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'support_case_id', v_existing_id,
        'correlation_id', v_correlation_id,
        'settings_resolution_id', v_settings_resolution_id,
        'already_processed', TRUE
      );
    END IF;
  END IF;

  -- 6) Insert canonical row (org-match enforced by trigger on support_cases).
  INSERT INTO public.support_cases (
    organization_id, client_id, sender_id, resource_type, resource_id,
    status, priority, subject, channel,
    sla_minutes, sla_due_at, opened_at,
    idempotency_key, metadata
  ) VALUES (
    v_org_id, v_client_id, v_sender_id, v_resource_type, v_resource_id,
    'open', v_priority, v_subject, v_channel,
    v_sla_minutes, v_sla_due_at, now(),
    v_idempotency_key, v_metadata
  )
  RETURNING id INTO v_case_id;

  -- 7) Append immutable case event (SSOT ledger).
  INSERT INTO public.support_case_events (
    support_case_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, idempotency_key, case_version,
    settings_resolution_id
  ) VALUES (
    v_case_id, v_org_id,
    'support_case.created', NULL, 'open',
    v_user_id,
    jsonb_build_object(
      'subject', v_subject,
      'priority', v_priority,
      'channel', v_channel,
      'sla_minutes', v_sla_minutes
    ),
    v_idempotency_key, 1,
    v_settings_resolution_id
  );

  -- 8) Emit engine-first domain event.
  PERFORM public.enqueue_domain_event(
    p_organization_id => v_org_id,
    p_event_type => 'support_case.created',
    p_resource_type => 'support_case',
    p_resource_id => v_case_id,
    p_payload => jsonb_build_object(
      'support_case_id', v_case_id,
      'priority', v_priority,
      'channel', v_channel,
      'subject', v_subject
    ),
    p_correlation_id => v_correlation_id
  );

  -- 9) Decision log row tied to settings resolution (override-ladder evidence).
  PERFORM public.log_decision(
    p_organization_id => v_org_id,
    p_decision_category => 'support_case.create',
    p_resource_type => 'support_case',
    p_resource_id => v_case_id,
    p_decision_point => 'create',
    p_decision_outcome => 'created',
    p_performed_by_system => 'create_support_case_v1',
    p_correlation_id => v_correlation_id,
    p_decision_inputs => jsonb_build_object(
      'priority', v_priority,
      'channel', v_channel,
      'sla_minutes', v_sla_minutes,
      'has_subject', v_subject IS NOT NULL,
      'client_id', v_client_id,
      'sender_id', v_sender_id
    ),
    p_settings_resolution_id => v_settings_resolution_id
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id
  );
END;
$function$;

COMMENT ON FUNCTION public.create_support_case_v1(JSONB)
  IS 'Canonical RPC to create a support case. Capability-gated (support.write); writes case + event + domain_event + decision_log.';

REVOKE ALL ON FUNCTION public.create_support_case_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_support_case_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_support_case_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604271220_create_support_case_v1'));
COMMIT;
