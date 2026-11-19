-- pgTAP: onboarding readiness blocks missing tenant/client/sender entities.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

CREATE OR REPLACE FUNCTION pg_temp.test_onboarding_readiness_strict_scope_entity_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_missing_tenant UUID := gen_random_uuid();
  v_status JSONB;
  v_readiness JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Onboarding Missing Scope Probe Org', 'onboarding-missing-scope-' || left(replace(v_org::text, '-', ''), 12));

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id,
    status
  )
  VALUES (
    v_user,
    v_org,
    format('onboarding-missing-scope-%s@example.test', left(replace(v_user::text, '-', ''), 12)),
    'Onboarding Missing Scope Super Admin',
    'super_admin',
    'platform',
    NULL,
    'active'
  );

  RETURN NEXT has_function(
    'public',
    'onboarding_readiness_scope_entity_status_v1',
    ARRAY['text', 'uuid'],
    'onboarding_readiness_scope_entity_status_v1 exists'
  );
  RETURN NEXT ok(
    NOT has_function_privilege(
      'authenticated',
      'public.onboarding_readiness_scope_entity_status_v1(text,uuid)',
      'EXECUTE'
    ),
    'authenticated cannot execute the strict entity helper directly'
  );

  SELECT public.onboarding_readiness_scope_entity_status_v1('tenant', v_missing_tenant)
    INTO v_status;

  RETURN NEXT is(
    v_status->>'ok',
    'false',
    'strict entity helper detects missing tenant organization'
  );
  RETURN NEXT is(
    v_status->>'entity_table',
    'organizations',
    'strict entity helper resolves tenant entity table from scope_type_registry'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'email', 'onboarding-missing-scope-super-admin@example.test'
    )::text,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_get_onboarding_readiness_v1('tenant', v_missing_tenant)
    INTO v_readiness;

  RETURN NEXT is(
    v_readiness->>'overall_status',
    'blocked',
    'api onboarding readiness blocks a missing tenant organization'
  );
  RETURN NEXT is(
    v_readiness->>'healthy',
    'false',
    'api onboarding readiness marks missing tenant organization unhealthy'
  );
  RETURN NEXT ok(
    COALESCE(v_readiness->'blocking_findings', '[]'::jsonb) @> jsonb_build_array(
      jsonb_build_object(
        'component', 'scope',
        'code', 'missing_scope_entity',
        'scope_type', 'tenant',
        'scope_id', v_missing_tenant
      )
    ),
    'api onboarding readiness surfaces missing_scope_entity finding'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_onboarding_readiness_strict_scope_entity_v1();

SELECT * FROM finish();

ROLLBACK;
