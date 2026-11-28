BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(14);

SELECT is(public.contactless_pod_signing_origin_v1(NULL, TRUE), NULL::text,
  'an opted-in tenant cannot mint a link without a deployed origin');
SELECT is(public.contactless_pod_signing_origin_v1('https://signing.example.invalid', FALSE), NULL::text,
  'a configured deployment cannot mint a link for a tenant that did not opt in');
SELECT is(public.contactless_pod_signing_origin_v1('https://signing.example.invalid', NULL), NULL::text,
  'a missing tenant setting fails closed');
SELECT is(public.contactless_pod_signing_origin_v1('http://signing.example.invalid', TRUE), NULL::text,
  'a plaintext customer link is rejected');
SELECT is(public.contactless_pod_signing_origin_v1('https://signing.example.invalid:65536', TRUE), NULL::text,
  'a malformed HTTPS origin fails closed');
SELECT is(public.contactless_pod_signing_origin_v1('https://signing.example.invalid/', TRUE), 'https://signing.example.invalid',
  'an enabled tenant uses the normalized deployed HTTPS origin');
SELECT ok(NOT has_function_privilege('anon', 'api.mint_contactless_pod_token_v1(uuid)', 'EXECUTE'),
  'an anonymous user cannot mint a signing link');
SELECT ok(NOT has_function_privilege('authenticated', 'api.submit_contactless_pod_v1(text,uuid,text,integer)', 'EXECUTE'),
  'an authenticated user cannot submit a signature directly');
SELECT ok(NOT has_function_privilege('anon', 'api.begin_contactless_pod_attempt_v1(text)', 'EXECUTE'),
  'anonymous callers cannot claim an attempt directly');

WITH allowed AS (
  SELECT ARRAY['api.begin_contactless_pod_attempt_v1(text)'::regprocedure,
    'api.submit_contactless_pod_v1(text,uuid,text,integer)'::regprocedure] AS functions
)
SELECT is(ARRAY(
  SELECT p.oid::regprocedure
  FROM pg_proc p
  WHERE p.pronamespace IN ('api'::regnamespace, 'public'::regnamespace)
    AND EXISTS (
      SELECT 1 FROM aclexplode(p.proacl) a
      WHERE a.grantee = 'contactless_pod_intake'::regrole AND a.privilege_type = 'EXECUTE'
    )
  ORDER BY p.oid::regprocedure::text
), functions, 'the intake role has direct execution grants only on the two signing RPCs')
FROM allowed
UNION ALL
SELECT ok(NOT (
  pg_has_role('authenticator', 'contactless_pod_intake', 'MEMBER')
    AND has_schema_privilege('contactless_pod_intake', 'api', 'USAGE')
) OR ARRAY(
  SELECT p.oid::regprocedure
  FROM pg_proc p
  WHERE p.pronamespace = 'api'::regnamespace
    AND has_function_privilege('contactless_pod_intake', p.oid, 'EXECUTE')
  ORDER BY p.oid::regprocedure::text
) = functions, 'the gateway cannot reach intake until only the two signing RPCs are callable')
FROM allowed;

CREATE FUNCTION pg_temp.test_contactless_pod_tenant_origin()
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_origin constant text := 'https://signing.example.invalid';
  v_secret uuid;
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_tenant, 'Signing policy test tenant', 'signing-test-' || v_tenant::text);
  PERFORM set_config('app.organization_onboarding_source', '', true);

  DELETE FROM vault.secrets WHERE name = 'contactless_pod_signing_origin';
  v_secret := vault.create_secret(v_origin, 'contactless_pod_signing_origin', 'Rollback-only signing test');
  RETURN NEXT is(public.contactless_pod_origin_for_tenant_v1(v_tenant), NULL::text,
    'the deployed origin alone does not enable signing for a tenant');

  DELETE FROM vault.secrets WHERE id = v_secret;
  WITH opt_in AS (
    INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
    VALUES ('customer_device_sign_policy', 'tenant', v_tenant, 1, '{"enabled":true}', 1, clock_timestamp())
    RETURNING id, value
  )
  INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  SELECT 'customer_device_sign_policy', 'tenant', v_tenant, id, value, clock_timestamp() FROM opt_in;
  RETURN NEXT is(public.contactless_pod_origin_for_tenant_v1(v_tenant), NULL::text,
    'the tenant opt-in alone does not enable signing without a deployed origin');

  PERFORM vault.create_secret(v_origin, 'contactless_pod_signing_origin', 'Rollback-only signing test');
  RETURN NEXT is(public.contactless_pod_origin_for_tenant_v1(v_tenant), v_origin,
    'the deployed origin is available when the tenant opts in');
END;
$$;

SELECT * FROM pg_temp.test_contactless_pod_tenant_origin();
SELECT * FROM finish();
ROLLBACK;
