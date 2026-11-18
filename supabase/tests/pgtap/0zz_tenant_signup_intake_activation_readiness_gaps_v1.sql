-- pgTAP: tenant signup intake, activation, and readiness gap closure.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(29);

SELECT has_function(
  'public',
  'tenant_signup_request_create_v1',
  ARRAY['text','text','text','text','text','text','text','text','text','text','text','jsonb','text','boolean'],
  'tenant_signup_request_create_v1 is available for public intake edge proof'
);

SELECT has_function(
  'public',
  'tenant_signup_review_apply_v1',
  ARRAY['uuid','text','uuid','text','uuid','boolean','text','jsonb'],
  'tenant_signup_review_apply_v1 is available for activation proof'
);

SELECT has_function(
  'public',
  'onboarding_readiness_snapshot_v1',
  ARRAY['text','uuid'],
  'onboarding_readiness_snapshot_v1 is available for tenant readiness proof'
);

SELECT has_function(
  'public',
  'ui_update_organization_profile_v1',
  ARRAY['jsonb'],
  'ui_update_organization_profile_v1 is available for org logo/defaults proof'
);

CREATE OR REPLACE FUNCTION pg_temp.exercise_tenant_signup_intake_activation_readiness_gaps_v1()
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  v_suffix TEXT := left(replace(gen_random_uuid()::text, '-', ''), 12);
  v_policy_original JSONB;
  v_policy JSONB;

  v_turnstile_email TEXT := format('turnstile-%s@example.test', v_suffix);
  v_turnstile JSONB;
  v_turnstile_rows INTEGER := 0;

  v_blocked_email TEXT := format('blocked-%s@blocked.test', v_suffix);
  v_blocked JSONB;
  v_blocked_rows INTEGER := 0;

  v_allow_email TEXT := format('allow-%s@other.test', v_suffix);
  v_allow JSONB;
  v_allow_rows INTEGER := 0;

  v_duplicate_email TEXT := format('duplicate-%s@example.test', v_suffix);
  v_duplicate_first JSONB;
  v_duplicate_second JSONB;
  v_duplicate_rows INTEGER := 0;

  v_rate_ip TEXT := format('rate-ip-%s', v_suffix);
  v_rate_first_email TEXT := format('rate-a-%s@example.test', v_suffix);
  v_rate_second_email TEXT := format('rate-b-%s@example.test', v_suffix);
  v_rate_first JSONB;
  v_rate_second JSONB;
  v_rate_rows INTEGER := 0;
  v_rate_second_rows INTEGER := 0;

  v_collision_org UUID := gen_random_uuid();
  v_collision_slug TEXT := 'activation-org-' || v_suffix;
  v_activation_email TEXT := format('activation-%s@example.test', v_suffix);
  v_activation_auth_user UUID := gen_random_uuid();
  v_activation_create JSONB;
  v_activation_approve JSONB;
  v_activation_request_id UUID;
  v_approved_org_id UUID;
  v_approved_user_id UUID;
  v_approved_org_slug TEXT;
  v_approved_status TEXT;
  v_invite_stored BOOLEAN := FALSE;
  v_org_user_materialized BOOLEAN := FALSE;
  v_role_assignment_exists BOOLEAN := FALSE;
  v_tenant_default_count INTEGER := 0;
  v_mobile_registered_count INTEGER := 0;
  v_mobile_seeded_count INTEGER := 0;
  v_bootstrap JSONB := '{}'::jsonb;
  v_bootstrap_error TEXT := NULL;
  v_readiness JSONB := '{}'::jsonb;
  v_profile_update JSONB := '{}'::jsonb;
  v_profile_error TEXT := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);

  v_policy_original := public.tenant_signup_policy_v1();

  v_policy := jsonb_set(COALESCE(v_policy_original, '{}'::jsonb), '{turnstile,required}', 'true'::jsonb, TRUE);
  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_policy,
    1,
    'pgtap: tenant intake turnstile required'
  );

  v_turnstile := public.tenant_signup_request_create_v1(
    v_turnstile_email,
    'Turnstile False User',
    'Turnstile False Org',
    NULL,
    NULL,
    NULL,
    'pgtap turnstile false',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    format('turnstile-ip-%s', v_suffix),
    FALSE
  );

  SELECT COUNT(*)::INTEGER
    INTO v_turnstile_rows
    FROM public.tenant_signup_requests
   WHERE lower(email) = lower(v_turnstile_email);

  v_policy := jsonb_set(COALESCE(v_policy_original, '{}'::jsonb), '{email_domains,allowlist}', '[]'::jsonb, TRUE);
  v_policy := jsonb_set(v_policy, '{email_domains,blocklist}', '["blocked.test"]'::jsonb, TRUE);
  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_policy,
    1,
    'pgtap: tenant intake blocked domain'
  );

  v_blocked := public.tenant_signup_request_create_v1(
    v_blocked_email,
    'Blocked Domain User',
    'Blocked Domain Org',
    NULL,
    NULL,
    NULL,
    'pgtap blocked domain',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    format('blocked-domain-ip-%s', v_suffix),
    TRUE
  );

  SELECT COUNT(*)::INTEGER
    INTO v_blocked_rows
    FROM public.tenant_signup_requests
   WHERE lower(email) = lower(v_blocked_email);

  v_policy := jsonb_set(COALESCE(v_policy_original, '{}'::jsonb), '{email_domains,allowlist}', '["allowed.test"]'::jsonb, TRUE);
  v_policy := jsonb_set(v_policy, '{email_domains,blocklist}', '[]'::jsonb, TRUE);
  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_policy,
    1,
    'pgtap: tenant intake allowlisted domain'
  );

  v_allow := public.tenant_signup_request_create_v1(
    v_allow_email,
    'Allowlist Domain User',
    'Allowlist Domain Org',
    NULL,
    NULL,
    NULL,
    'pgtap allowlist domain',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    format('allow-domain-ip-%s', v_suffix),
    TRUE
  );

  SELECT COUNT(*)::INTEGER
    INTO v_allow_rows
    FROM public.tenant_signup_requests
   WHERE lower(email) = lower(v_allow_email);

  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_policy_original,
    1,
    'pgtap: tenant intake restore policy for dedupe'
  );

  v_duplicate_first := public.tenant_signup_request_create_v1(
    v_duplicate_email,
    'Duplicate Requester User',
    'Duplicate Requester Org',
    NULL,
    NULL,
    NULL,
    'pgtap duplicate requester first',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    format('duplicate-ip-a-%s', v_suffix),
    TRUE
  );

  v_duplicate_second := public.tenant_signup_request_create_v1(
    v_duplicate_email,
    'Duplicate Requester User Again',
    'Duplicate Requester Org Again',
    NULL,
    NULL,
    NULL,
    'pgtap duplicate requester second',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    format('duplicate-ip-b-%s', v_suffix),
    TRUE
  );

  SELECT COUNT(*)::INTEGER
    INTO v_duplicate_rows
    FROM public.tenant_signup_requests
   WHERE lower(email) = lower(v_duplicate_email);

  v_policy := jsonb_set(COALESCE(v_policy_original, '{}'::jsonb), '{rate_limit,window_seconds}', to_jsonb(3600), TRUE);
  v_policy := jsonb_set(v_policy, '{rate_limit,max_requests}', to_jsonb(1), TRUE);
  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_policy,
    1,
    'pgtap: tenant intake ip rate limit'
  );

  v_rate_first := public.tenant_signup_request_create_v1(
    v_rate_first_email,
    'Rate Limit User A',
    'Rate Limit Org A',
    NULL,
    NULL,
    NULL,
    'pgtap rate first',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    v_rate_ip,
    TRUE
  );

  v_rate_second := public.tenant_signup_request_create_v1(
    v_rate_second_email,
    'Rate Limit User B',
    'Rate Limit Org B',
    NULL,
    NULL,
    NULL,
    'pgtap rate second',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    v_rate_ip,
    TRUE
  );

  SELECT COUNT(*)::INTEGER
    INTO v_rate_rows
    FROM public.tenant_signup_requests
   WHERE ip_hash = v_rate_ip;

  SELECT COUNT(*)::INTEGER
    INTO v_rate_second_rows
    FROM public.tenant_signup_requests
   WHERE lower(email) = lower(v_rate_second_email);

  v_policy := jsonb_set(COALESCE(v_policy_original, '{}'::jsonb), '{approval_mode}', '"required"'::jsonb, TRUE);
  v_policy := jsonb_set(v_policy, '{onboarding,provision_on_approval}', 'true'::jsonb, TRUE);
  v_policy := jsonb_set(v_policy, '{onboarding,initial_user_type}', '"ops_admin"'::jsonb, TRUE);
  v_policy := jsonb_set(v_policy, '{onboarding,initial_role_key}', '"ops_admin"'::jsonb, TRUE);
  v_policy := jsonb_set(v_policy, '{onboarding,invite_redirect_to}', '"https://console.example.test/onboarding"'::jsonb, TRUE);
  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_policy,
    1,
    'pgtap: tenant activation provisioning'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_collision_org, 'Activation Slug Collision Org', v_collision_slug);

  v_activation_create := public.tenant_signup_request_create_v1(
    v_activation_email,
    'Activation User',
    'Activation Org',
    v_collision_slug,
    'https://activation.example.test',
    NULL,
    'pgtap activation provisioning',
    'en',
    'https://example.test/signup',
    NULL,
    'https://example.test',
    '{}'::jsonb,
    format('activation-ip-%s', v_suffix),
    TRUE
  );
  v_activation_request_id := NULLIF(v_activation_create->>'id', '')::uuid;

  v_activation_approve := public.tenant_signup_review_apply_v1(
    v_activation_request_id,
    'approved',
    NULL,
    'pgtap activation approval',
    v_activation_auth_user,
    TRUE,
    'https://console.example.test/invite',
    jsonb_build_object('source', 'pgtap')
  );

  SELECT
    r.status,
    r.approved_organization_id,
    r.approved_user_id,
    (
      r.approved_auth_user_id = v_activation_auth_user
      AND r.invite_email_sent_at IS NOT NULL
      AND r.invite_redirect_to = 'https://console.example.test/invite'
    )
    INTO
      v_approved_status,
      v_approved_org_id,
      v_approved_user_id,
      v_invite_stored
    FROM public.tenant_signup_requests r
   WHERE r.id = v_activation_request_id;

  SELECT o.slug
    INTO v_approved_org_slug
    FROM public.organizations o
   WHERE o.id = v_approved_org_id;

  SELECT EXISTS (
    SELECT 1
      FROM public.organizations o
      JOIN public.users u ON u.organization_id = o.id
     WHERE o.id = v_approved_org_id
       AND o.name = 'Activation Org'
       AND u.id = v_activation_auth_user
       AND u.id = v_approved_user_id
       AND lower(u.email) = lower(v_activation_email)
       AND u.access_scope_type = 'tenant'
       AND u.access_scope_id IS NULL
  )
  INTO v_org_user_materialized;

  SELECT EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments a
      JOIN public.rbac_roles r ON r.id = a.role_id
     WHERE a.organization_id = v_approved_org_id
       AND a.user_id = v_approved_user_id
       AND a.revoked_at IS NULL
       AND r.key = 'ops_admin'
  )
  INTO v_role_assignment_exists;

  PERFORM set_config('request.jwt.claim.sub', v_approved_user_id::text, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_approved_user_id,
      'role', 'authenticated',
      'email', v_activation_email
    )::text,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    v_bootstrap := public.ui_execute_onboarding_bootstrap_v1('tenant', v_approved_org_id);
  EXCEPTION
    WHEN others THEN
      v_bootstrap_error := SQLSTATE || ':' || SQLERRM;
  END;

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);

  SELECT COUNT(*)::INTEGER
    INTO v_tenant_default_count
    FROM public.settings s
   WHERE s.scope_type = 'tenant'
     AND s.scope_id = v_approved_org_id;

  SELECT COUNT(*)::INTEGER
    INTO v_mobile_registered_count
    FROM public.settings_category_registry scr
   WHERE scr.category IN (
     'mobile_ingest_policy',
     'mobile_visibility_policy',
     'mobile_diagnostics_policy',
     'mobile_push_policy',
     'mobile_sync_policy'
   );

  SELECT COUNT(*)::INTEGER
    INTO v_mobile_seeded_count
    FROM public.settings s
   WHERE s.scope_type = 'tenant'
     AND s.scope_id = v_approved_org_id
     AND s.category IN (
       'mobile_ingest_policy',
       'mobile_visibility_policy',
       'mobile_diagnostics_policy',
       'mobile_push_policy',
       'mobile_sync_policy'
     );

  v_readiness := public.onboarding_readiness_snapshot_v1('tenant', v_approved_org_id);

  PERFORM set_config('request.jwt.claim.sub', v_approved_user_id::text, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_approved_user_id,
      'role', 'authenticated',
      'email', v_activation_email
    )::text,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    v_profile_update := public.ui_update_organization_profile_v1(
      jsonb_build_object(
        'organization_id', v_approved_org_id,
        'logo_url', 'https://cdn.example.test/activation-logo.png',
        'default_settings_patch', jsonb_build_object(
          'mobile', jsonb_build_object('policy_profile', 'fieldops-default')
        )
      )
    );
  EXCEPTION
    WHEN others THEN
      v_profile_error := SQLSTATE || ':' || SQLERRM;
  END;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN jsonb_build_object(
    'turnstile_code', v_turnstile #>> '{error,code}',
    'turnstile_rows', v_turnstile_rows,
    'blocked_code', v_blocked #>> '{error,code}',
    'blocked_rows', v_blocked_rows,
    'allow_code', v_allow #>> '{error,code}',
    'allow_rows', v_allow_rows,
    'duplicate_first_id', v_duplicate_first->>'id',
    'duplicate_second_id', v_duplicate_second->>'id',
    'duplicate_second_deduped', COALESCE((v_duplicate_second->>'deduped')::boolean, FALSE),
    'duplicate_rows', v_duplicate_rows,
    'rate_first_ok', COALESCE((v_rate_first->>'ok')::boolean, FALSE),
    'rate_second_code', v_rate_second #>> '{error,code}',
    'rate_rows', v_rate_rows,
    'rate_second_rows', v_rate_second_rows,
    'activation_create_ok', COALESCE((v_activation_create->>'ok')::boolean, FALSE),
    'activation_approve_ok', COALESCE((v_activation_approve->>'ok')::boolean, FALSE),
    'approved_status', v_approved_status,
    'approved_org_id', v_approved_org_id,
    'approved_user_id', v_approved_user_id,
    'approved_org_slug', v_approved_org_slug,
    'collision_slug', v_collision_slug,
    'invite_stored', v_invite_stored,
    'org_user_materialized', v_org_user_materialized,
    'role_assignment_exists', v_role_assignment_exists,
    'bootstrap_ok', COALESCE((v_bootstrap->>'ok')::boolean, FALSE),
    'bootstrap_error', v_bootstrap_error,
    'tenant_default_count', v_tenant_default_count,
    'mobile_registered_count', v_mobile_registered_count,
    'mobile_seeded_count', v_mobile_seeded_count,
    'readiness_scope_type', v_readiness->>'scope_type',
    'readiness_scope_id', v_readiness->>'scope_id',
    'readiness_organization_id', v_readiness->>'organization_id',
    'readiness_settings_healthy', COALESCE((v_readiness #>> '{settings_defaults,healthy}')::boolean, FALSE),
    'profile_ok', COALESCE((v_profile_update->>'ok')::boolean, FALSE),
    'profile_error', v_profile_error,
    'profile_logo_url', (
      SELECT o.default_settings #>> '{branding,logo_url}'
      FROM public.organizations o
      WHERE o.id = v_approved_org_id
    ),
    'profile_mobile_policy_profile', (
      SELECT o.default_settings #>> '{mobile,policy_profile}'
      FROM public.organizations o
      WHERE o.id = v_approved_org_id
    )
  );
END;
$function$;

CREATE TEMP TABLE pg_temp.tenant_signup_intake_activation_readiness_result AS
SELECT pg_temp.exercise_tenant_signup_intake_activation_readiness_gaps_v1() AS payload;

SELECT is(
  payload->>'turnstile_code',
  'turnstile_required',
  'tenant intake rejects Turnstile false when Turnstile is required'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  (payload->>'turnstile_rows')::INTEGER,
  0,
  'tenant intake Turnstile false creates no request row'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  payload->>'blocked_code',
  'domain_blocked',
  'tenant intake rejects blocklisted requester email domains'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  (payload->>'blocked_rows')::INTEGER,
  0,
  'tenant intake blocklisted domain creates no request row'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  payload->>'allow_code',
  'domain_not_allowed',
  'tenant intake rejects non-allowlisted requester email domains'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  (payload->>'allow_rows')::INTEGER,
  0,
  'tenant intake non-allowlisted domain creates no request row'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'duplicate_second_deduped')::BOOLEAN, FALSE)
  AND payload->>'duplicate_first_id' = payload->>'duplicate_second_id',
  'tenant intake duplicate requester email returns the existing review queue item'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  (payload->>'duplicate_rows')::INTEGER,
  1,
  'tenant intake duplicate requester email does not create a second row'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'rate_first_ok')::BOOLEAN, FALSE),
  'tenant intake accepts the first request within an IP rate window'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  payload->>'rate_second_code',
  'rate_limited',
  'tenant intake rejects the second distinct requester from the same IP when the policy limit is reached'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  (payload->>'rate_rows')::INTEGER,
  1,
  'tenant intake IP rate limiting creates only the first request row'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  (payload->>'rate_second_rows')::INTEGER,
  0,
  'tenant intake IP rate limiting creates no row for the rejected requester'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'activation_create_ok')::BOOLEAN, FALSE)
  AND COALESCE((payload->>'activation_approve_ok')::BOOLEAN, FALSE),
  'tenant approval provisioning request and approval both succeed'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  payload->>'approved_status',
  'approved',
  'tenant approval persists approved request status'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'org_user_materialized')::BOOLEAN, FALSE),
  'tenant approval materializes the organization and initial tenant user'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  payload->>'approved_org_slug' <> payload->>'collision_slug'
  AND payload->>'approved_org_slug' LIKE (payload->>'collision_slug') || '-%',
  'tenant approval materializes a unique organization slug when the requested slug already exists'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'invite_stored')::BOOLEAN, FALSE),
  'tenant approval stores invite email and redirect metadata on the request'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'role_assignment_exists')::BOOLEAN, FALSE),
  'tenant approval grants the initial RBAC role to the materialized user'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'bootstrap_ok')::BOOLEAN, FALSE)
  AND payload->>'bootstrap_error' IS NULL
  AND
  (payload->>'tenant_default_count')::INTEGER > 0,
  'explicit onboarding bootstrap materializes tenant defaults after approval'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  (payload->>'mobile_registered_count')::INTEGER > 0
  AND (payload->>'mobile_seeded_count')::INTEGER = (payload->>'mobile_registered_count')::INTEGER,
  'explicit onboarding bootstrap materializes registered mobile policy defaults for the tenant'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  payload->>'readiness_scope_type' = 'tenant'
  AND payload->>'readiness_scope_id' = payload->>'approved_org_id'
  AND payload->>'readiness_organization_id' = payload->>'approved_org_id',
  'tenant readiness snapshot resolves the approved tenant scope'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'readiness_settings_healthy')::BOOLEAN, FALSE),
  'tenant readiness marks required settings defaults healthy after explicit bootstrap'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT ok(
  COALESCE((payload->>'profile_ok')::BOOLEAN, FALSE)
  AND payload->>'profile_error' IS NULL,
  'materialized tenant admin can update organization logo/default settings through the canonical RPC'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  payload->>'profile_logo_url',
  'https://cdn.example.test/activation-logo.png',
  'organization logo URL is persisted under default_settings.branding'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT is(
  payload->>'profile_mobile_policy_profile',
  'fieldops-default',
  'organization default settings patch persists mobile policy profile'
)
FROM pg_temp.tenant_signup_intake_activation_readiness_result;

SELECT * FROM finish();

ROLLBACK;
