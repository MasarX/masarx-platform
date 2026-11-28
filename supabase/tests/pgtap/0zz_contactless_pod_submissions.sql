BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(40);

SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contactless_pod_submissions'::regclass),
  'signing receipts have row-level security');
SELECT ok(NOT has_table_privilege('authenticated', 'public.contactless_pod_submissions', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.contactless_pod_submissions', 'SELECT'),
  'signing receipts cannot be read directly by application roles');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'api.pending_customer_sign_events_v1(uuid)'::regprocedure),
  'the signing readback runs behind a scoped definer');
SELECT ok(has_function_privilege('authenticated', 'api.pending_customer_sign_events_v1(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.pending_customer_sign_events_v1(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'api.pending_customer_sign_events_v1(uuid)', 'EXECUTE'),
  'only the authenticated application role can poll signing receipts');

SELECT set_eq(
  $$SELECT p.oid::regprocedure
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    CROSS JOIN pg_catalog.pg_roles AS r
    WHERE n.nspname IN ('public', 'api')
      AND p.prokind <> 'p'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS d
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.objsubid = 0
          AND d.refclassid = 'pg_extension'::regclass
          AND d.deptype = 'e'
      )
      AND r.rolname = 'contactless_pod_intake'
      AND has_function_privilege(r.oid, p.oid, 'EXECUTE')$$,
  $$SELECT unnest(ARRAY[
    'api.begin_contactless_pod_attempt_v1(text)'::regprocedure,
    'api.submit_contactless_pod_v1(text, uuid, text, integer)'::regprocedure
  ])$$,
  'the signing intake role can execute exactly the two signing RPCs in public and api');
SELECT ok((SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit
  FROM pg_catalog.pg_roles WHERE rolname = 'contactless_pod_intake'),
  'the signing intake role has NOLOGIN, NOSUPERUSER, NOBYPASSRLS and NOINHERIT');

CREATE FUNCTION pg_temp.contactless_fixture()
RETURNS TABLE (org uuid, driver uuid, task uuid, stop uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_branch uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_shipment uuid := gen_random_uuid();
  v_route record;
BEGIN
  org := gen_random_uuid();
  driver := gen_random_uuid();
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations (id, name, slug)
  VALUES (org, 'Signing fixture tenant', 'signing-fixture-' || org::text);
  PERFORM set_config('app.organization_onboarding_source', '', true);
  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, org, 'signing-fixture', 'Signing fixture branch', 'UTC', true);
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, org, 'Signing fixture client', 'signing-client-' || v_client::text, 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (driver, org, 'driver-' || driver::text || '@example.test', 'Signing fixture driver', 'driver', 'active', 'tenant');
  PERFORM public.bootstrap_tenant_onboarding_v1(org, 'contactless-signing-fixture');
  PERFORM public.upsert_settings_value_v1('customer_device_sign_policy', 'tenant', org, '{"enabled":true}', 1, 'Signing fixture opt-in');
  INSERT INTO public.shipments (id, organization_id, client_id, tracking_number, service_type, status)
  VALUES (v_shipment, org, v_client, 'SIGN-' || v_shipment::text, 'delivery', 'pending');
  SELECT * INTO STRICT v_route FROM public.create_route_run_v1(jsonb_build_object(
    'organization_id', org, 'branch_id', v_branch,
    'stops', jsonb_build_array(jsonb_build_object(
      'client_id', v_client, 'shipment_id', v_shipment, 'stop_kind', 'delivery', 'sequence_order', 1
    ))
  ));
  stop := v_route.stop_ids[1];
  SELECT result.task_id INTO STRICT task FROM public.create_task_system_v1(jsonb_build_object(
    'task_type_key', 'route_stop_execute', 'context', jsonb_build_object('organization_id', org, 'client_id', v_client),
    'resource_type', 'route_stop', 'resource_id', stop, 'actor_system', 'dispatch_engine',
    'idempotency_key', 'signing-fixture-' || org::text
  )) result;
  PERFORM public.assign_task_v1(task, driver);
  PERFORM public.transition_task_system_v1(
    task, 'assigned', p_actor_system => 'dispatch_engine', p_idempotency_key => 'signing-assign-' || org::text
  );
  RETURN NEXT;
END;
$$;

CREATE FUNCTION pg_temp.test_contactless_submissions()
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_a record;
  v_b record;
  v_attempt jsonb;
  v_other_attempt jsonb;
  v_hash text := repeat('a', 64);
  v_token text := repeat('b', 64);
  v_other_token text := repeat('c', 64);
  v_expired_token text := repeat('d', 64);
  v_limit_token text := repeat('e', 64);
  v_closed_token text := repeat('f', 64);
  v_fails boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  DELETE FROM vault.secrets WHERE name = 'contactless_pod_signing_origin';
  PERFORM vault.create_secret('https://signing.example.invalid', 'contactless_pod_signing_origin', 'Rollback-only signing test');
  SELECT * INTO STRICT v_a FROM pg_temp.contactless_fixture();
  SELECT * INTO STRICT v_b FROM pg_temp.contactless_fixture();
  INSERT INTO storage.buckets (id, name, public) VALUES ('fieldops-evidence', 'fieldops-evidence', false) ON CONFLICT DO NOTHING;

  INSERT INTO public.contactless_pod_submissions (organization_id, task_id, issued_by, token_digest, expires_at) VALUES
    (v_a.org, v_a.task, v_a.driver, extensions.digest(v_token, 'sha256'), clock_timestamp() + interval '5 minutes'),
    (v_b.org, v_b.task, v_b.driver, extensions.digest(v_other_token, 'sha256'), clock_timestamp() + interval '5 minutes'),
    (v_a.org, v_a.task, v_a.driver, extensions.digest(v_expired_token, 'sha256'), clock_timestamp() - interval '1 second'),
    (v_a.org, v_a.task, v_a.driver, extensions.digest(v_limit_token, 'sha256'), clock_timestamp() + interval '5 minutes'),
    (v_a.org, v_a.task, v_a.driver, extensions.digest(v_closed_token, 'sha256'), clock_timestamp() + interval '5 minutes');

  v_attempt := api.begin_contactless_pod_attempt_v1(v_token);
  v_other_attempt := api.begin_contactless_pod_attempt_v1(v_other_token);
  RETURN NEXT ok(v_attempt->>'storage_key' LIKE v_a.org::text || '/' || v_a.task::text || '/%', 'attempt is bound to its tenant and task path');
  RETURN NEXT ok(v_other_attempt->>'storage_key' LIKE v_b.org::text || '/' || v_b.task::text || '/%', 'the other tenant has its own evidence path');
  RETURN NEXT is(api.begin_contactless_pod_attempt_v1(v_token), NULL::jsonb, 'one attempt at a time can use a token');
  RETURN NEXT is(api.begin_contactless_pod_attempt_v1(v_expired_token), NULL::jsonb, 'an expired signing link cannot claim an attempt');

  -- Represent the storage service upload for this database contract test.
  INSERT INTO storage.objects (bucket_id, name, metadata)
  VALUES
    ('fieldops-evidence', v_attempt->>'storage_key', '{"size":68,"mimetype":"image/png"}'),
    ('fieldops-evidence', v_other_attempt->>'storage_key', '{"size":68,"mimetype":"image/png"}');
  RETURN NEXT is(api.submit_contactless_pod_v1(v_token, (v_other_attempt->>'attempt_id')::uuid, v_hash, 68), false,
    'a signing token cannot submit the attempt or proof path for another task and tenant');
  RETURN NEXT is(api.submit_contactless_pod_v1(v_token, (v_attempt->>'attempt_id')::uuid, v_hash, 67), false,
    'the stored proof must match the submitted size');
  RETURN NEXT is(api.submit_contactless_pod_v1(v_token, (v_attempt->>'attempt_id')::uuid, v_hash, 68), true,
    'the first valid submit registers the reserved PNG');
  RETURN NEXT is(api.submit_contactless_pod_v1(v_token, (v_attempt->>'attempt_id')::uuid, v_hash, 68), false,
    'the same submit cannot consume the signing link twice');
  RETURN NEXT is(api.begin_contactless_pod_attempt_v1(v_token), NULL::jsonb, 'a consumed link cannot start another attempt');
  RETURN NEXT ok(EXISTS (
    SELECT 1 FROM public.artifacts a JOIN public.artifact_links l
      ON l.artifact_id = a.id AND l.organization_id = a.organization_id
    WHERE a.organization_id = v_a.org AND a.storage_bucket = 'fieldops-evidence'
      AND a.storage_key = v_attempt->>'storage_key' AND a.sha256 = v_hash
      AND l.resource_type = 'task' AND l.resource_id = v_a.task AND l.relation_type = 'pod'
  ), 'the PNG uses existing tenant proof storage and the task evidence link');

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_a.driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_a.driver)::text, true);
  RETURN NEXT is((SELECT array_agg(task_id) FROM api.pending_customer_sign_events_v1(v_a.driver)), ARRAY[v_a.task]::uuid[],
    'the driver can read only their signed task and receives no pending submissions');
  RETURN NEXT is((SELECT count(*) FROM api.pending_customer_sign_events_v1(v_b.driver)), 0::bigint,
    'a driver cannot supply a different driver identity');
  RETURN NEXT is((SELECT count(*) FROM api.pending_customer_sign_events_v1(NULL)), 0::bigint,
    'a missing driver identity returns no signing receipts');
  PERFORM set_config('request.jwt.claim.sub', v_b.driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_b.driver)::text, true);
  RETURN NEXT is((SELECT count(*) FROM api.pending_customer_sign_events_v1(v_a.driver)), 0::bigint,
    'the other tenant cannot poll the driver with a signed task');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  FOR i IN 1..5 LOOP
    v_attempt := api.begin_contactless_pod_attempt_v1(v_limit_token);
    v_fails := v_fails AND v_attempt IS NOT NULL
      AND api.submit_contactless_pod_v1(v_limit_token, (v_attempt->>'attempt_id')::uuid, NULL, NULL) IS FALSE;
  END LOOP;
  RETURN NEXT ok(v_fails, 'five rejected attempts are recorded');
  RETURN NEXT is(api.begin_contactless_pod_attempt_v1(v_limit_token), NULL::jsonb, 'five rejected attempts burn the link');

  UPDATE public.contactless_pod_submissions SET expires_at = clock_timestamp() - interval '1 second'
  WHERE token_digest = extensions.digest(v_other_token, 'sha256');
  RETURN NEXT is(api.submit_contactless_pod_v1(v_other_token, (v_other_attempt->>'attempt_id')::uuid, v_hash, 68), false,
    'expiry is checked again when an already-reserved attempt submits');
  UPDATE public.contactless_pod_submissions SET expires_at = clock_timestamp() + interval '5 minutes'
  WHERE token_digest = extensions.digest(v_other_token, 'sha256');

  PERFORM public.upsert_settings_value_v1('customer_device_sign_policy', 'tenant', v_b.org, '{"enabled":false}', 1, 'Signing fixture opt-out');
  RETURN NEXT is(api.submit_contactless_pod_v1(v_other_token, (v_other_attempt->>'attempt_id')::uuid, v_hash, 68), false,
    'opting out revokes an already-reserved signing attempt');
  v_attempt := api.begin_contactless_pod_attempt_v1(v_closed_token);
  INSERT INTO storage.objects (bucket_id, name, metadata)
  VALUES ('fieldops-evidence', v_attempt->>'storage_key', '{"size":68,"mimetype":"image/png"}');
  DELETE FROM vault.secrets WHERE name = 'contactless_pod_signing_origin';
  RETURN NEXT is(api.submit_contactless_pod_v1(v_closed_token, (v_attempt->>'attempt_id')::uuid, v_hash, 68), false,
    'removing the origin revokes an already-reserved signing attempt');
  RETURN NEXT is(api.begin_contactless_pod_attempt_v1(v_closed_token), NULL::jsonb, 'an unset origin also blocks new attempts');
END;
$$;

SELECT * FROM pg_temp.test_contactless_submissions();

CREATE FUNCTION pg_temp.check_contactless_signing_access(
  p_actor uuid, p_task uuid, p_allowed boolean, p_case text
)
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_link text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_actor)::text, true);
  SET LOCAL ROLE authenticated;
  RETURN NEXT is(api.contactless_pod_link_available_v1(p_task), p_allowed, 'signing availability: ' || p_case);
  v_link := api.mint_contactless_pod_token_v1(p_task);
  RETURN NEXT ok(
    CASE WHEN p_allowed
      THEN v_link ~ '^https://signing[.]example[.]invalid/delivery-signing#token=[0-9a-f]{64}$'
      ELSE v_link IS NULL
    END, 'signing mint: ' || p_case
  );
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
END;
$$;

CREATE FUNCTION pg_temp.test_contactless_signing_access()
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_home record;
  v_foreign record;
  v_other_driver uuid := gen_random_uuid();
  v_limited_actor uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SELECT * INTO STRICT v_home FROM pg_temp.contactless_fixture();
  SELECT * INTO STRICT v_foreign FROM pg_temp.contactless_fixture();
  DELETE FROM vault.secrets WHERE name = 'contactless_pod_signing_origin';
  PERFORM vault.create_secret('https://signing.example.invalid', 'contactless_pod_signing_origin', 'Rollback-only signing access test');
  INSERT INTO storage.buckets (id, name, public) VALUES ('fieldops-evidence', 'fieldops-evidence', false) ON CONFLICT DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_other_driver, v_home.org, v_other_driver || '@example.test', 'Other signing driver', 'driver', 'active', 'tenant'),
    (v_limited_actor, v_home.org, v_limited_actor || '@example.test', 'Limited signing actor', 'finance_viewer', 'active', 'tenant');

  RETURN QUERY SELECT * FROM pg_temp.check_contactless_signing_access(v_home.driver, v_home.task, true, 'assigned driver');
  RETURN QUERY SELECT * FROM pg_temp.check_contactless_signing_access(v_other_driver, v_home.task, false, 'unassigned driver in the same tenant');

  -- Represent a stale foreign assignment so the tenant check is exercised independently.
  UPDATE public.tasks SET assigned_to = v_foreign.driver WHERE id = v_home.task;
  RETURN QUERY SELECT * FROM pg_temp.check_contactless_signing_access(v_foreign.driver, v_home.task, false, 'assigned actor in another tenant');
  UPDATE public.tasks SET assigned_to = v_limited_actor WHERE id = v_home.task;
  RETURN QUERY SELECT * FROM pg_temp.check_contactless_signing_access(v_limited_actor, v_home.task, false, 'assigned actor without tasks.complete');
  UPDATE public.tasks SET assigned_to = v_home.driver WHERE id = v_home.task;

  UPDATE public.route_stops SET stop_kind = 'pickup' WHERE id = v_home.stop;
  RETURN QUERY SELECT * FROM pg_temp.check_contactless_signing_access(v_home.driver, v_home.task, false, 'assigned pickup stop');
  UPDATE public.route_stops SET stop_kind = 'delivery' WHERE id = v_home.stop;

  UPDATE public.tasks SET status = 'open' WHERE id = v_home.task;
  RETURN QUERY SELECT * FROM pg_temp.check_contactless_signing_access(v_home.driver, v_home.task, false, 'delivery task outside active status');
  UPDATE public.tasks SET status = 'assigned' WHERE id = v_home.task;

  PERFORM public.upsert_settings_value_v1('customer_device_sign_policy', 'tenant', v_home.org, '{"enabled":false}', 1, 'Signing access fixture opt-out');
  RETURN QUERY SELECT * FROM pg_temp.check_contactless_signing_access(v_home.driver, v_home.task, false, 'tenant without signing opt-in');
END;
$$;

SELECT * FROM pg_temp.test_contactless_signing_access();
SELECT * FROM finish();
ROLLBACK;
