BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(43);

SELECT has_function('public', 'tenant_signup_request_create_core_v1',
  ARRAY['text','text','text','text','text','text','text','text','text','text','text','jsonb','text','boolean','uuid'],
  'one private shared creation core exists');
SELECT ok(to_regprocedure('api.tenant_signup_request_create_core_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean,uuid)') IS NULL,
  'private core has no API facade');
SELECT ok(NOT has_function_privilege('anon', 'public.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)', 'EXECUTE'),
  'public intake stays inaccessible to anonymous callers');
SELECT ok(NOT has_function_privilege('authenticated', 'public.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)', 'EXECUTE'),
  'public intake stays inaccessible to authenticated callers');
SELECT ok(has_function_privilege('service_role', 'public.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)', 'EXECUTE'),
  'existing service intake retains its grant');
SELECT ok(has_function_privilege('authenticated', 'api.tenant_signup_request_create_reviewer_v1(jsonb)', 'EXECUTE'),
  'authenticated reviewers reach the checked API facade');
SELECT ok(NOT has_function_privilege('service_role', 'public.tenant_signup_request_create_reviewer_v1(jsonb)', 'EXECUTE'),
  'service credential alone does not gain the reviewer entry');

CREATE FUNCTION pg_temp.test_tenant_signup_reviewer_queue_create_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_reviewer UUID := gen_random_uuid();
  v_other_reviewer UUID := gen_random_uuid();
  v_tenant_operator UUID := gen_random_uuid();
  v_nonreviewer UUID := gen_random_uuid();
  v_policy JSONB;
  v_input JSONB;
  v_result JSONB;
  v_replay JSONB;
  v_other JSONB;
  v_id UUID;
  v_org_count BIGINT;
  v_user_count BIGINT;
  v_auth_count BIGINT;
  v_request_count BIGINT;
  v_public_zero_count INTEGER := 0;
  v_index INTEGER;
BEGIN
  INSERT INTO public.organizations(id, name, slug)
  VALUES (v_org, 'Reviewer queue fixture', 'reviewer-queue-' || left(v_org::TEXT, 8));
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (v_reviewer, v_org, 'reviewer-' || v_reviewer::TEXT || '@example.com', 'Reviewer', 'ops_admin', 'active', 'platform', NULL),
    (v_other_reviewer, v_org, 'reviewer-' || v_other_reviewer::TEXT || '@example.com', 'Other reviewer', 'ops_admin', 'active', 'platform', NULL),
    (v_tenant_operator, v_org, 'tenant-' || v_tenant_operator::TEXT || '@example.com', 'Tenant operator', 'ops_admin', 'active', 'tenant', NULL),
    (v_nonreviewer, v_org, 'driver-' || v_nonreviewer::TEXT || '@example.com', 'Nonreviewer', 'driver', 'active', 'platform', NULL);

  v_policy := public.tenant_signup_policy_v1();
  v_policy := jsonb_set(v_policy, '{enabled}', 'true');
  v_policy := jsonb_set(v_policy, '{turnstile,required}', 'true');
  v_policy := jsonb_set(v_policy, '{approval_mode}', '"auto"');
  v_policy := jsonb_set(v_policy, '{notifications,reviewer_in_app}', 'false');
  v_policy := jsonb_set(v_policy, '{rate_limit,window_seconds}', '60');
  v_policy := jsonb_set(v_policy, '{rate_limit,max_requests}', '2');
  v_policy := jsonb_set(v_policy, '{dedupe,window_seconds}', '86400');
  v_policy := jsonb_set(v_policy, '{email_domains,allowlist}', '[]');
  v_policy := jsonb_set(v_policy, '{email_domains,blocklist}', '[]');
  PERFORM public.upsert_settings_value_v1('tenant_signup_policy', 'global', NULL, v_policy, 1, 'pgTAP reviewer policy fixture');

  SELECT count(*) INTO v_org_count FROM public.organizations;
  SELECT count(*) INTO v_user_count FROM public.users;
  SELECT count(*) INTO v_auth_count FROM auth.users;
  v_input := jsonb_build_object(
    'email', 'queued-' || v_reviewer::TEXT || '@example.com',
    'full_name', 'Requested Person', 'organization_name', 'Prospective Organization',
    'organization_id', v_org, 'created_by_user_id', v_other_reviewer,
    'turnstile_verified', TRUE, 'decision', 'approved',
    'marketing', jsonb_build_object('created_by_user_id', v_other_reviewer, 'source', 'spoofed')
  );

  EXECUTE 'SET LOCAL ROLE anon';
  RETURN NEXT throws_ok($sql$SELECT public.tenant_signup_request_create_core_v1('a@example.com','Name','Org')$sql$,
    '42501', NULL, 'anon cannot call the private core');
  RETURN NEXT throws_ok($sql$SELECT api.tenant_signup_request_create_reviewer_v1('{}')$sql$,
    '42501', NULL, 'anon cannot call reviewer creation');
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok($sql$SELECT public.tenant_signup_request_create_core_v1('a@example.com','Name','Org')$sql$,
    '42501', NULL, 'service role cannot call the private core');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok($sql$SELECT public.tenant_signup_request_create_core_v1('a@example.com','Name','Org')$sql$,
    '42501', NULL, 'authenticated callers cannot call the private core');
  RETURN NEXT throws_ok($sql$SELECT api.tenant_signup_request_create_v1('a@example.com','Name','Org')$sql$,
    '42501', NULL, 'authenticated callers cannot call service intake');
  RETURN NEXT throws_ok($sql$SELECT api.tenant_signup_request_create_reviewer_v1('{}')$sql$,
    '42501', NULL, 'missing authenticated actor is denied');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_operator::TEXT, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_tenant_operator, 'role', 'authenticated')::TEXT, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok($sql$SELECT api.tenant_signup_request_create_reviewer_v1('{}')$sql$,
    '42501', NULL, 'tenant-scoped operator cannot create a platform queue request');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_nonreviewer::TEXT, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_nonreviewer, 'role', 'authenticated')::TEXT, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok($sql$SELECT api.tenant_signup_request_create_reviewer_v1('{}')$sql$,
    '42501', NULL, 'platform actor without review capability is denied');
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_reviewer::TEXT, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_reviewer, 'role', 'authenticated')::TEXT, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.tenant_signup_request_create_reviewer_v1(v_input);
  v_id := NULLIF(v_result->>'id', '')::UUID;
  RETURN NEXT is(v_result->>'ok', 'true', 'verified platform reviewer can queue without public Turnstile');
  RETURN NEXT ok(v_id IS NOT NULL, 'creation returns a request id');
  RETURN NEXT is(v_result->>'status', 'pending', 'reviewer creation is pending even under auto policy');
  RETURN NEXT is(v_result->>'auto_approve', 'false', 'reviewer result never authorizes auto approval');
  RETURN NEXT is((SELECT status FROM public.tenant_signup_requests WHERE id = v_id), 'pending',
    'reviewer can read back the pending queue row through existing RLS');
  v_replay := api.tenant_signup_request_create_reviewer_v1(v_input);
  RETURN NEXT is(v_replay->>'id', v_id::TEXT, 'replay reuses the canonical dedupe id');
  RETURN NEXT is(v_replay->>'deduped', 'true', 'replay reports dedupe rather than a new request');
  v_result := api.tenant_signup_request_create_reviewer_v1(v_input || jsonb_build_object('email', 'second-' || v_reviewer::TEXT || '@example.com'));
  RETURN NEXT is(v_result->>'ok', 'true', 'second target email uses the same reviewer budget');
  v_result := api.tenant_signup_request_create_reviewer_v1(v_input || jsonb_build_object('email', 'third-' || v_reviewer::TEXT || '@example.com', 'ip_hash', 'spoofed-rate-key'));
  RETURN NEXT is(v_result #>> '{error,code}', 'rate_limited', 'different email and spoofed key cannot evade per-reviewer rate limit');
  RETURN NEXT is(api.tenant_signup_request_create_reviewer_v1('[]') #>> '{error,code}', 'invalid_input', 'non-object reviewer input is rejected');
  EXECUTE 'RESET ROLE';

  RETURN NEXT is((SELECT turnstile_verified FROM public.tenant_signup_requests WHERE id = v_id), FALSE, 'reviewer creation honestly stores false challenge verification');
  RETURN NEXT is((SELECT marketing->>'created_by_user_id' FROM public.tenant_signup_requests WHERE id = v_id), v_reviewer::TEXT, 'verified reviewer overrides spoofed actor');
  RETURN NEXT is((SELECT marketing->>'source' FROM public.tenant_signup_requests WHERE id = v_id), 'console.organizations.requests', 'trusted source overrides spoofed marketing source');
  RETURN NEXT is((SELECT metadata->>'created_by_user_id' FROM public.tenant_signup_requests WHERE id = v_id), v_reviewer::TEXT, 'canonical metadata retains actual actor lineage');
  RETURN NEXT is((SELECT count(*) FROM public.tenant_signup_requests WHERE email = v_input->>'email'), 1::BIGINT, 'replay does not duplicate the queue row');
  RETURN NEXT ok(EXISTS (SELECT 1 FROM public.audit_table_changes WHERE table_name = 'tenant_signup_requests'
    AND op = 'INSERT' AND pk->>'id' = v_id::TEXT AND changed_by = v_reviewer::TEXT), 'existing audit trigger records the verified reviewer');
  RETURN NEXT is((SELECT count(*) FROM public.organizations), v_org_count, 'queue creation never provisions an organization');
  RETURN NEXT is((SELECT count(*) FROM public.users), v_user_count, 'queue creation never creates a product user');
  RETURN NEXT is((SELECT count(*) FROM auth.users), v_auth_count, 'queue creation never authenticates or creates an auth account');
  RETURN NEXT ok((SELECT reviewed_at IS NULL AND review_decision IS NULL AND approved_organization_id IS NULL
    AND approved_user_id IS NULL AND approved_auth_user_id IS NULL AND invite_email_sent_at IS NULL
    FROM public.tenant_signup_requests WHERE id = v_id), 'queue creation cannot approve, provision or send an invitation');

  PERFORM set_config('request.jwt.claim.sub', v_other_reviewer::TEXT, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_other_reviewer, 'role', 'authenticated')::TEXT, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_other := api.tenant_signup_request_create_reviewer_v1(v_input || jsonb_build_object('email', 'other-' || v_other_reviewer::TEXT || '@example.com'));
  RETURN NEXT is(v_other->>'ok', 'true', 'another verified reviewer has an independent policy budget');
  EXECUTE 'RESET ROLE';
  RETURN NEXT ok((SELECT ip_hash FROM public.tenant_signup_requests WHERE id = (v_other->>'id')::UUID)
    IS DISTINCT FROM (SELECT ip_hash FROM public.tenant_signup_requests WHERE id = v_id), 'per-reviewer keys are distinct');

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_reviewer, 'role', 'service_role')::TEXT, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok($sql$SELECT api.tenant_signup_request_create_v1('a@example.com','Name','Org')$sql$,
    '42501', NULL, 'claim spoofing does not grant authenticated callers service intake');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  v_result := api.tenant_signup_request_create_v1('public-denied@example.com', 'Public', 'Organization', p_turnstile_verified := FALSE);
  RETURN NEXT is(v_result #>> '{error,code}', 'turnstile_required', 'public service facade still requires genuine challenge verification');
  v_result := api.tenant_signup_request_create_v1('public-' || v_org::TEXT || '@example.com', 'Public', 'Organization', p_turnstile_verified := TRUE);
  RETURN NEXT is(v_result->>'ok', 'true', 'genuine service intake contract still works');
  EXECUTE 'RESET ROLE';

  v_policy := jsonb_set(v_policy, '{rate_limit,max_requests}', '0');
  PERFORM public.upsert_settings_value_v1('tenant_signup_policy', 'global', NULL, v_policy, 1, 'pgTAP zero-limit policy fixture');
  SELECT count(*) INTO v_request_count FROM public.tenant_signup_requests;
  PERFORM set_config('request.jwt.claim.sub', v_reviewer::TEXT, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_reviewer, 'role', 'authenticated')::TEXT, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.tenant_signup_request_create_reviewer_v1(v_input || jsonb_build_object('email', 'zero-reviewer-' || v_reviewer::TEXT || '@example.com'));
  RETURN NEXT is(v_result #>> '{error,code}', 'reviewer_rate_limit_required', 'reviewer zero-limit policy is rejected without inventing a cap');
  EXECUTE 'RESET ROLE';
  RETURN NEXT is((SELECT count(*) FROM public.tenant_signup_requests), v_request_count, 'reviewer zero-limit denial creates no rows');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  FOR v_index IN 1..3 LOOP
    v_result := api.tenant_signup_request_create_v1(
      'zero-public-' || v_index || '-' || v_org::TEXT || '@example.com', 'Public', 'Organization',
      p_ip_hash := 'zero-public-' || v_org::TEXT, p_turnstile_verified := TRUE
    );
    IF v_result->>'ok' = 'true' THEN v_public_zero_count := v_public_zero_count + 1; END IF;
  END LOOP;
  RETURN NEXT is(v_public_zero_count, 3, 'public zero-limit policy stays unlimited beyond the previous fixture cap');
  EXECUTE 'RESET ROLE';
END;
$function$;

SELECT * FROM pg_temp.test_tenant_signup_reviewer_queue_create_v1();
SELECT * FROM finish();
ROLLBACK;
