-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S04
-- Migration: Adopt workflow bindings for tenant-signup review routing
-- Date: 2026-03-09
--
-- Purpose:
-- - Replace the direct create_task_system_v1 call in tenant_signup_request_create_v1
--   with run_workflow_binding_stage_v1 while keeping the API contract stable.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091351_tenant_signup_workflow_binding_adoption_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.tenant_signup_request_create_v1(
  p_email TEXT,
  p_full_name TEXT,
  p_organization_name TEXT,
  p_organization_slug TEXT DEFAULT NULL,
  p_website_url TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_locale TEXT DEFAULT NULL,
  p_page_url TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT NULL,
  p_marketing JSONB DEFAULT '{}'::jsonb,
  p_ip_hash TEXT DEFAULT NULL,
  p_turnstile_verified BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_turnstile_required BOOLEAN;
  v_window_seconds INT;
  v_max_requests INT;
  v_dedupe_seconds INT;

  v_now TIMESTAMPTZ := now();
  v_id UUID := gen_random_uuid();

  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
  v_full_name TEXT := btrim(COALESCE(p_full_name, ''));
  v_org_name TEXT := btrim(COALESCE(p_organization_name, ''));
  v_org_slug TEXT := NULLIF(btrim(COALESCE(p_organization_slug, '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(p_ip_hash, '')), '');

  v_email_domain TEXT := lower(split_part(v_email, '@', 2));
  v_allow_domains TEXT[] := ARRAY[]::TEXT[];
  v_block_domains TEXT[] := ARRAY[]::TEXT[];

  v_approval_mode TEXT := 'required';
  v_auto_approve BOOLEAN := FALSE;

  v_recent_count INT := 0;
  v_existing RECORD;

  v_task_enabled BOOLEAN;
  v_task_org_slug TEXT;
  v_task_type_key TEXT;
  v_task_queue TEXT;
  v_task_priority INT;
  v_task_sla_minutes INT;
  v_task_org_id UUID;
  v_task_id UUID := NULL;
  v_task_workflow_run_id UUID := NULL;
  v_dispatch_result JSONB := '{}'::jsonb;
  v_step_result JSONB := '{}'::jsonb;

  v_invite_redirect_to TEXT;
BEGIN
  v_policy := public.tenant_signup_policy_v1();

  v_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['enabled'], FALSE);
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  v_turnstile_required := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['turnstile', 'required'], TRUE);
  IF v_turnstile_required AND NOT COALESCE(p_turnstile_verified, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'turnstile_required'));
  END IF;

  IF v_email = '' OR position('@' IN v_email) < 2 OR position('.' IN v_email_domain) < 2 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_email'));
  END IF;

  IF v_full_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'full_name_required'));
  END IF;

  IF v_org_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'organization_required'));
  END IF;

  v_allow_domains := public.tenant_signup_jsonb_text_array_v1(v_policy #> ARRAY['email_domains', 'allowlist']);
  v_block_domains := public.tenant_signup_jsonb_text_array_v1(v_policy #> ARRAY['email_domains', 'blocklist']);

  IF array_length(v_allow_domains, 1) IS NOT NULL
     AND NOT (v_email_domain = ANY(v_allow_domains)) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'domain_not_allowed'));
  END IF;

  IF array_length(v_block_domains, 1) IS NOT NULL
     AND v_email_domain = ANY(v_block_domains) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'domain_blocked'));
  END IF;

  v_window_seconds := public.tenant_signup_policy_int_v1(v_policy, ARRAY['rate_limit', 'window_seconds'], 60, 1, 86400);
  v_max_requests := public.tenant_signup_policy_int_v1(v_policy, ARRAY['rate_limit', 'max_requests'], 10, 0, 100000);

  IF v_ip_hash IS NOT NULL AND v_max_requests > 0 THEN
    SELECT COUNT(*)
      INTO v_recent_count
      FROM public.tenant_signup_requests r
     WHERE r.ip_hash = v_ip_hash
       AND r.created_at >= (v_now - (v_window_seconds || ' seconds')::interval);

    IF v_recent_count >= v_max_requests THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
    END IF;
  END IF;

  v_dedupe_seconds := public.tenant_signup_policy_int_v1(v_policy, ARRAY['dedupe', 'window_seconds'], 86400, 0, 2592000);
  IF v_dedupe_seconds > 0 THEN
    SELECT r.id, r.status, r.created_at
      INTO v_existing
      FROM public.tenant_signup_requests r
     WHERE lower(r.email) = v_email
       AND r.created_at >= (v_now - (v_dedupe_seconds || ' seconds')::interval)
     ORDER BY r.created_at DESC
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      v_approval_mode := lower(COALESCE(NULLIF(v_policy->>'approval_mode', ''), 'required'));
      IF v_approval_mode NOT IN ('required', 'auto') THEN
        v_approval_mode := 'required';
      END IF;

      RETURN jsonb_build_object(
        'ok', TRUE,
        'id', v_existing.id,
        'status', COALESCE(v_existing.status, 'pending'),
        'deduped', TRUE,
        'approval_mode', v_approval_mode,
        'auto_approve', (v_approval_mode = 'auto')
      );
    END IF;
  END IF;

  v_approval_mode := lower(COALESCE(NULLIF(v_policy->>'approval_mode', ''), 'required'));
  IF v_approval_mode NOT IN ('required', 'auto') THEN
    v_approval_mode := 'required';
  END IF;
  v_auto_approve := (v_approval_mode = 'auto');

  v_invite_redirect_to := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['onboarding', 'invite_redirect_to'], '')), '');

  INSERT INTO public.tenant_signup_requests (
    id,
    created_at,
    updated_at,
    status,
    email,
    full_name,
    organization_name,
    organization_slug,
    website_url,
    phone,
    notes,
    locale,
    page_url,
    referrer,
    origin,
    marketing,
    metadata,
    ip_hash,
    turnstile_verified
  ) VALUES (
    v_id,
    v_now,
    v_now,
    'pending',
    v_email,
    v_full_name,
    v_org_name,
    v_org_slug,
    NULLIF(btrim(COALESCE(p_website_url, '')), ''),
    NULLIF(btrim(COALESCE(p_phone, '')), ''),
    NULLIF(btrim(COALESCE(p_notes, '')), ''),
    NULLIF(btrim(COALESCE(p_locale, '')), ''),
    NULLIF(btrim(COALESCE(p_page_url, '')), ''),
    NULLIF(btrim(COALESCE(p_referrer, '')), ''),
    NULLIF(btrim(COALESCE(p_origin, '')), ''),
    COALESCE(p_marketing, '{}'::jsonb),
    jsonb_build_object(
      'approval_mode', v_approval_mode,
      'created_via', 'tenant_signup_request_create_v1'
    ),
    v_ip_hash,
    COALESCE(p_turnstile_verified, FALSE)
  );

  v_task_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['notifications', 'reviewer_in_app'], TRUE);

  IF v_task_enabled THEN
    BEGIN
      v_task_org_slug := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['task', 'organization_slug'], '')), '');
      IF v_task_org_slug IS NULL THEN
        v_task_org_slug := 'global-root';
      END IF;

      SELECT o.id
        INTO v_task_org_id
        FROM public.organizations o
       WHERE o.slug = v_task_org_slug
       LIMIT 1;

      IF v_task_org_id IS NOT NULL THEN
        v_task_type_key := lower(COALESCE(NULLIF(btrim(v_policy #>> ARRAY['task', 'task_type_key']), ''), 'tenant_signup_review'));
        v_task_queue := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['task', 'queue_key'], '')), '');
        v_task_priority := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'priority'], 40, 0, 1000);
        v_task_sla_minutes := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'sla_minutes'], 60, 1, 10080);

        v_dispatch_result := public.run_workflow_binding_stage_v1(
          jsonb_build_object(
            'binding_key', 'tenant_signup',
            'stage_key', 'review_requested',
            'organization_id', v_task_org_id,
            'resource_type', 'tenant_signup_request',
            'resource_id', v_id,
            'actor_system', 'tenant-signup-intake',
            'source_function', 'tenant_signup_request_create_v1',
            'idempotency_key', format('tenant_signup_review:%s', v_id),
            'context', jsonb_build_object(
              'binding_payload',
              jsonb_build_object(
                'task',
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'organization_id', v_task_org_id,
                    'task_type_key', v_task_type_key,
                    'resource_type', 'tenant_signup_request',
                    'resource_id', v_id,
                    'queue_key', v_task_queue,
                    'priority', v_task_priority,
                    'sla_minutes', v_task_sla_minutes,
                    'idempotency_key', format('tenant_signup_review:%s', v_id),
                    'metadata', jsonb_build_object(
                      'request_id', v_id,
                      'email', v_email,
                      'full_name', v_full_name,
                      'organization_name', v_org_name
                    ),
                    'actor_system', 'tenant-signup-intake'
                  )
                )
              )
            )
          )
        );

        v_step_result := public.workflow_binding_dispatch_step_result_v1(v_dispatch_result);
        BEGIN v_task_id := NULLIF(v_step_result->>'task_id', '')::UUID; EXCEPTION WHEN others THEN v_task_id := NULL; END;
        BEGIN v_task_workflow_run_id := NULLIF(v_step_result->>'workflow_run_id', '')::UUID; EXCEPTION WHEN others THEN v_task_workflow_run_id := NULL; END;
      END IF;
    EXCEPTION
      WHEN others THEN
        UPDATE public.tenant_signup_requests
           SET last_error_code = 'task_enqueue_failed',
               last_error_message = left(SQLERRM, 800),
               last_error_at = now(),
               decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
                 || jsonb_build_object('task_enqueue_error', left(SQLERRM, 800))
         WHERE id = v_id;
    END;
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'id', v_id,
      'status', 'pending',
      'approval_mode', v_approval_mode,
      'auto_approve', v_auto_approve,
      'invite_redirect_to', v_invite_redirect_to,
      'task_id', v_task_id,
      'workflow_run_id', v_task_workflow_run_id,
      'dispatch_id', NULLIF(v_dispatch_result->>'dispatch_id', '')::UUID,
      'binding_workflow_run_id', NULLIF(v_dispatch_result->>'workflow_run_id', '')::UUID
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.tenant_signup_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
  IS 'Tenant signup intake RPC: validates and inserts tenant_signup_requests, then dispatches tenant_signup/review_requested via workflow bindings while preserving task_id/workflow_run_id contract.';

SELECT pg_advisory_unlock(hashtext('202603091351_tenant_signup_workflow_binding_adoption_v1'));
COMMIT;
