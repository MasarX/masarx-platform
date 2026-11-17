-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S95
-- Fix marketplace participant request review-task creation to carry the
-- target organization through task context so task-type bootstrap and task
-- creation resolve correctly.

BEGIN;

CREATE OR REPLACE FUNCTION public.marketplace_participant_request_create_v1(
  p_requested_participant_type_key TEXT,
  p_email TEXT,
  p_full_name TEXT,
  p_organization_name TEXT,
  p_organization_slug TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_website_url TEXT DEFAULT NULL,
  p_locale TEXT DEFAULT NULL,
  p_page_url TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT NULL,
  p_experience_summary TEXT DEFAULT NULL,
  p_capabilities_requested JSONB DEFAULT '[]'::jsonb,
  p_verification_documents JSONB DEFAULT '[]'::jsonb,
  p_marketing JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_requested_organization_id UUID DEFAULT NULL,
  p_requested_by_user_id UUID DEFAULT NULL,
  p_ip_hash TEXT DEFAULT NULL,
  p_turnstile_verified BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_type_key TEXT := lower(btrim(COALESCE(p_requested_participant_type_key, '')));
  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
  v_full_name TEXT := btrim(COALESCE(p_full_name, ''));
  v_org_name TEXT := btrim(COALESCE(p_organization_name, ''));
  v_org_slug TEXT := NULLIF(btrim(COALESCE(p_organization_slug, '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(p_ip_hash, '')), '');
  v_now TIMESTAMPTZ := now();
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_turnstile_required BOOLEAN;
  v_window_seconds INT;
  v_max_requests INT;
  v_dedupe_seconds INT;
  v_allow_public_intake BOOLEAN := FALSE;
  v_recent_count INT := 0;
  v_existing RECORD;
  v_request_id UUID := gen_random_uuid();
  v_status_token UUID := gen_random_uuid();
  v_task_enabled BOOLEAN := TRUE;
  v_task_org_slug TEXT := 'global-root';
  v_task_type_key TEXT := 'marketplace_participant_review';
  v_task_queue TEXT := 'marketplace_participant_review';
  v_task_priority INT := 45;
  v_task_sla_minutes INT := 120;
  v_task_org_id UUID := NULL;
  v_task_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
BEGIN
  v_policy := public.marketplace_compliance_policy_v1(
    jsonb_build_object(
      'organization_id', p_requested_organization_id,
      'participant_type_key', v_type_key
    )
  );

  v_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['enabled'], FALSE);
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  v_allow_public_intake := public.tenant_signup_policy_bool_v1(
    v_policy,
    ARRAY['participant_types', v_type_key, 'allow_public_intake'],
    FALSE
  );
  IF NOT v_allow_public_intake AND p_requested_organization_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'public_intake_not_allowed'));
  END IF;

  v_turnstile_required := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['turnstile', 'required'], TRUE);
  IF v_turnstile_required AND NOT COALESCE(p_turnstile_verified, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'turnstile_required'));
  END IF;

  IF v_type_key = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_type_required'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.marketplace_registry_entries e
     WHERE e.registry_type = 'participant_type'
       AND e.entry_key = v_type_key
       AND e.is_active = TRUE
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_type_invalid'));
  END IF;

  IF v_email = '' OR position('@' IN v_email) < 2 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_email'));
  END IF;

  IF v_full_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'full_name_required'));
  END IF;

  IF v_org_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'organization_required'));
  END IF;

  v_window_seconds := public.tenant_signup_policy_int_v1(v_policy, ARRAY['rate_limit', 'window_seconds'], 60, 1, 86400);
  v_max_requests := public.tenant_signup_policy_int_v1(v_policy, ARRAY['rate_limit', 'max_requests'], 10, 0, 100000);
  v_dedupe_seconds := public.tenant_signup_policy_int_v1(v_policy, ARRAY['dedupe', 'window_seconds'], 86400, 0, 31536000);

  IF v_ip_hash IS NOT NULL AND v_max_requests > 0 THEN
    SELECT COUNT(*)
      INTO v_recent_count
      FROM public.marketplace_participant_requests r
     WHERE r.ip_hash = v_ip_hash
       AND r.created_at >= (v_now - (v_window_seconds || ' seconds')::interval);

    IF v_recent_count >= v_max_requests THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
    END IF;
  END IF;

  IF v_dedupe_seconds > 0 THEN
    SELECT r.*
      INTO v_existing
      FROM public.marketplace_participant_requests r
     WHERE lower(r.email) = v_email
       AND r.requested_participant_type_key = v_type_key
       AND r.created_at >= (v_now - (v_dedupe_seconds || ' seconds')::interval)
     ORDER BY r.created_at DESC
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'id', v_existing.id,
        'status', v_existing.status,
        'deduped', TRUE,
        'application_status_token', v_existing.public_status_token
      );
    END IF;
  END IF;

  INSERT INTO public.marketplace_participant_requests (
    id,
    status,
    requested_participant_type_key,
    requested_by_user_id,
    requested_organization_id,
    email,
    full_name,
    organization_name,
    organization_slug,
    phone,
    website_url,
    locale,
    page_url,
    referrer,
    origin,
    experience_summary,
    capabilities_requested,
    verification_documents,
    marketing,
    metadata,
    ip_hash,
    turnstile_verified,
    public_status_token
  )
  VALUES (
    v_request_id,
    'pending',
    v_type_key,
    p_requested_by_user_id,
    p_requested_organization_id,
    v_email,
    v_full_name,
    v_org_name,
    v_org_slug,
    NULLIF(btrim(COALESCE(p_phone, '')), ''),
    NULLIF(btrim(COALESCE(p_website_url, '')), ''),
    NULLIF(btrim(COALESCE(p_locale, '')), ''),
    NULLIF(btrim(COALESCE(p_page_url, '')), ''),
    NULLIF(btrim(COALESCE(p_referrer, '')), ''),
    NULLIF(btrim(COALESCE(p_origin, '')), ''),
    NULLIF(btrim(COALESCE(p_experience_summary, '')), ''),
    CASE WHEN jsonb_typeof(p_capabilities_requested) = 'array' THEN p_capabilities_requested ELSE '[]'::jsonb END,
    CASE WHEN jsonb_typeof(p_verification_documents) = 'array' THEN p_verification_documents ELSE '[]'::jsonb END,
    COALESCE(p_marketing, '{}'::jsonb),
    COALESCE(p_metadata, '{}'::jsonb),
    v_ip_hash,
    COALESCE(p_turnstile_verified, FALSE),
    v_status_token
  );

  v_task_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['task', 'enabled'], TRUE);
  v_task_org_slug := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'organization_slug'], ''), 'global-root');
  v_task_type_key := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'task_type_key'], ''), 'marketplace_participant_review');
  v_task_queue := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'queue_key'], ''), 'marketplace_participant_review');
  v_task_priority := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'priority'], 45, 0, 1000);
  v_task_sla_minutes := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'sla_minutes'], 120, 0, 10080);

  IF v_task_enabled THEN
    SELECT o.id
      INTO v_task_org_id
      FROM public.organizations o
     WHERE o.slug = v_task_org_slug
     LIMIT 1;

    IF v_task_org_id IS NOT NULL THEN
      BEGIN
        SELECT t.task_id, t.workflow_run_id
          INTO v_task_id, v_workflow_run_id
          FROM public.create_task_system_v1(
            jsonb_build_object(
              'task_type_key', v_task_type_key,
              'context', jsonb_build_object(
                'organization_id', v_task_org_id,
                'marketplace_participant_request_id', v_request_id,
                'requested_participant_type_key', v_type_key,
                'requested_organization_id', p_requested_organization_id
              ),
              'resource_type', 'marketplace_participant_request',
              'resource_id', v_request_id,
              'queue_key', v_task_queue,
              'priority', v_task_priority,
              'sla_minutes', v_task_sla_minutes,
              'idempotency_key', 'marketplace-participant-request:' || v_request_id::text,
              'metadata', jsonb_build_object(
                'organization_id', v_task_org_id,
                'source', 'marketplace_participant_request_create_v1'
              ),
              'actor_system', 'marketplace_participant_request_create_v1'
            )
          ) AS t;
      EXCEPTION
        WHEN others THEN
          PERFORM public.marketplace_participant_request_record_error_v1(
            v_request_id,
            'task_create_failed',
            SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE)
          );
      END;
    END IF;
  END IF;

  PERFORM public.marketplace_append_event_v1(
    COALESCE(p_requested_organization_id, public.marketplace_system_org_id_v1()),
    'marketplace_participant_request',
    v_request_id,
    'participant_request.created',
    jsonb_build_object(
      'requested_participant_type_key', v_type_key,
      'task_id', v_task_id,
      'workflow_run_id', v_workflow_run_id
    )
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'id', v_request_id,
      'status', 'pending',
      'task_id', v_task_id,
      'workflow_run_id', v_workflow_run_id,
      'application_status_token', v_status_token
    )
  );
END;
$function$;

COMMIT;
