-- Trusted platform reviewers may queue signup requests without asserting a public challenge.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261020140000_tenant_signup_reviewer_queue_create_v1'));

-- One implementation retains the existing policy, validation, dedupe and workflow path.
CREATE OR REPLACE FUNCTION public.tenant_signup_request_create_core_v1(
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
  p_turnstile_verified BOOLEAN DEFAULT FALSE,
  p_reviewer_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_reviewer JSONB;
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
  IF p_reviewer_user_id IS NOT NULL THEN
    v_reviewer := public.tenant_signup_assert_reviewer_v1();
    IF p_reviewer_user_id IS DISTINCT FROM auth.uid()
       OR v_reviewer->>'user_id' IS DISTINCT FROM p_reviewer_user_id::TEXT THEN
      RAISE EXCEPTION 'tenant_signup reviewer actor mismatch' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_policy := public.tenant_signup_policy_v1();

  v_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['enabled'], FALSE);
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  v_turnstile_required := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['turnstile', 'required'], TRUE);
  IF p_reviewer_user_id IS NULL AND v_turnstile_required AND NOT COALESCE(p_turnstile_verified, FALSE) THEN
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

  IF p_reviewer_user_id IS NOT NULL AND v_max_requests <= 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'reviewer_rate_limit_required'));
  END IF;

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
    ) || CASE WHEN p_reviewer_user_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
      'created_via', 'tenant_signup_request_create_reviewer_v1',
      'created_by_user_id', p_reviewer_user_id,
      'source', 'console.organizations.requests'
    ) END,
    v_ip_hash,
    CASE WHEN p_reviewer_user_id IS NULL THEN COALESCE(p_turnstile_verified, FALSE) ELSE FALSE END
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

REVOKE ALL ON FUNCTION public.tenant_signup_request_create_core_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN, UUID
) FROM PUBLIC, anon, authenticated, service_role;

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
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.tenant_signup_request_create_core_v1(
    p_email, p_full_name, p_organization_name, p_organization_slug,
    p_website_url, p_phone, p_notes, p_locale, p_page_url, p_referrer,
    p_origin, p_marketing, p_ip_hash, p_turnstile_verified, NULL
  );
$function$;

REVOKE ALL ON FUNCTION public.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_signup_request_create_reviewer_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_reviewer JSONB;
  v_actor UUID;
  v_reviewer_key TEXT;
  v_result JSONB;
BEGIN
  v_reviewer := public.tenant_signup_assert_reviewer_v1();
  v_actor := auth.uid();
  IF v_actor IS NULL OR v_reviewer->>'user_id' IS DISTINCT FROM v_actor::TEXT
     OR v_reviewer->>'scope_type' IS DISTINCT FROM 'platform'
     OR v_reviewer->>'ok' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'tenant_signup reviewer session required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_input'));
  END IF;

  -- One key per verified reviewer, never per target email; serialize its policy counter.
  v_reviewer_key := encode(extensions.digest('tenant-signup-reviewer:' || v_actor::TEXT, 'sha256'), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_reviewer_key, 0));

  v_result := public.tenant_signup_request_create_core_v1(
    p_email := p_input->>'email',
    p_full_name := p_input->>'full_name',
    p_organization_name := p_input->>'organization_name',
    p_organization_slug := p_input->>'organization_slug',
    p_website_url := p_input->>'website_url',
    p_phone := p_input->>'phone',
    p_notes := p_input->>'notes',
    p_locale := p_input->>'locale',
    p_page_url := NULL,
    p_referrer := 'console.organizations.requests',
    p_origin := NULL,
    p_marketing := (CASE WHEN jsonb_typeof(p_input->'marketing') = 'object'
      THEN p_input->'marketing' ELSE '{}'::jsonb END) || jsonb_build_object(
        'source', 'console.organizations.requests', 'created_by_user_id', v_actor
      ),
    p_ip_hash := v_reviewer_key,
    p_turnstile_verified := FALSE,
    p_reviewer_user_id := v_actor
  );
  -- Queue creation never authorizes the public intake handler's auto-approval path.
  RETURN v_result || jsonb_build_object('auto_approve', FALSE);
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_signup_request_create_reviewer_v1(JSONB)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_signup_request_create_reviewer_v1(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION api.tenant_signup_request_create_reviewer_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.tenant_signup_request_create_reviewer_v1(p_input);
$function$;

REVOKE ALL ON FUNCTION api.tenant_signup_request_create_reviewer_v1(JSONB)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION api.tenant_signup_request_create_reviewer_v1(JSONB) TO authenticated;

COMMENT ON FUNCTION public.tenant_signup_request_create_reviewer_v1(JSONB)
  IS 'Platform reviewer-only pending signup queue creation; actual actor audit, policy rate limit per reviewer, no public challenge claim or provisioning.';
COMMENT ON FUNCTION public.tenant_signup_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
  IS 'Service-only public intake facade; genuine Turnstile and existing policy/create contracts retained.';

COMMIT;
