-- pgTAP: Tenant signup approval defers heavy organization insert bootstrap.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

CREATE OR REPLACE FUNCTION pg_temp.test_tenant_signup_approval_deferred_org_bootstrap_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_auth_user_id UUID := gen_random_uuid();
  v_create JSONB;
  v_approve JSONB;
  v_req_id UUID;
  v_org_id UUID;
  v_user_id UUID;
  v_settings_count INTEGER;
  v_bootstrap JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  RETURN NEXT has_function(
    'public',
    'trigger_bootstrap_tenant_onboarding_v1',
    ARRAY[]::TEXT[],
    'organizations insert onboarding trigger function exists'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        COALESCE(
          public.resolve_saas_onboarding_policy_v1() #> ARRAY['organization_insert_trigger', 'defer_sources'],
          '[]'::jsonb
        )
      ) AS source(value)
      WHERE source.value = 'tenant_signup_review_apply_v1'
    ),
    'saas onboarding policy defers tenant signup approval organization insert bootstrap'
  );

  v_create := public.tenant_signup_request_create_v1(
    p_email := format('tenant-signup-fast-approval-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_full_name := 'Tenant Signup Fast Approval User',
    p_organization_name := 'Tenant Signup Fast Approval Org',
    p_organization_slug := NULL,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap fast approval with deferred org bootstrap',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-ip-fast-approval-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );
  v_req_id := NULLIF(v_create->>'id', '')::uuid;

  SET LOCAL statement_timeout = '6000ms';

  v_approve := public.tenant_signup_review_apply_v1(
    p_request_id := v_req_id,
    p_decision := 'approved',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap fast approval with deferred org bootstrap',
    p_invited_auth_user_id := v_auth_user_id,
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := NULL,
    p_decision_metadata := '{}'::jsonb
  );

  SET LOCAL statement_timeout = '60000ms';

  v_org_id := NULLIF(v_approve->>'organization_id', '')::uuid;
  v_user_id := NULLIF(v_approve->>'user_id', '')::uuid;

  RETURN NEXT ok(
    COALESCE((v_approve->>'ok')::boolean, FALSE),
    'tenant signup approval completes inside the fast approval timeout'
  );

  RETURN NEXT is(
    (SELECT status FROM public.tenant_signup_requests WHERE id = v_req_id),
    'approved',
    'tenant signup request is approved'
  );

  RETURN NEXT ok(
    v_org_id IS NOT NULL AND v_user_id = v_auth_user_id,
    'approval returns the provisioned organization and first user'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.rbac_user_role_assignments ura
      JOIN public.rbac_roles r
        ON r.id = ura.role_id
      WHERE ura.organization_id = v_org_id
        AND ura.user_id = v_user_id
        AND r.key = 'ops_admin'
        AND ura.revoked_at IS NULL
    ),
    'approval still grants the initial ops_admin role'
  );

  SELECT count(*)::INTEGER
    INTO v_settings_count
    FROM public.settings s
   WHERE s.scope_type = 'tenant'
     AND s.scope_id = v_org_id;

  RETURN NEXT is(
    v_settings_count,
    0,
    'approval defers tenant settings materialization out of the organization insert trigger'
  );

  v_bootstrap := public.bootstrap_tenant_onboarding_v1(
    v_org_id,
    'pgtap:deferred-signup-approval-readiness-bootstrap'
  );

  RETURN NEXT ok(
    COALESCE((v_bootstrap->>'ok')::boolean, FALSE),
    'explicit onboarding bootstrap completes after deferred approval'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.scope_type = 'tenant'
        AND s.scope_id = v_org_id
    ),
    'explicit onboarding bootstrap materializes tenant settings'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.service_levels sl
      WHERE sl.organization_id = v_org_id
        AND sl.key IN ('standard', 'express', 'same_day')
        AND sl.is_active IS TRUE
    ),
    'explicit onboarding bootstrap provisions operational service levels'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_tenant_signup_approval_deferred_org_bootstrap_v1();

SELECT * FROM finish();

ROLLBACK;
