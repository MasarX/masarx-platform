-- pgTAP: caller-bound approved tenant-signup summary.
BEGIN;
SET search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

SELECT has_function('public', 'tenant_signup_request_approved_summary_v1', ARRAY['uuid'], 'public approved signup summary exists');
SELECT has_function('api', 'tenant_signup_request_approved_summary_v1', ARRAY['uuid'], 'api approved signup summary wrapper exists');

SELECT is((
  SELECT string_agg(COALESCE(r.rolname, 'PUBLIC'), ',' ORDER BY COALESCE(r.rolname, 'PUBLIC'))
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_roles r ON r.oid=a.grantee
  WHERE p.oid='public.tenant_signup_request_approved_summary_v1(uuid)'::regprocedure
    AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
), 'authenticated', 'public summary execute grant is authenticated only');
SELECT is((
  SELECT string_agg(COALESCE(r.rolname, 'PUBLIC'), ',' ORDER BY COALESCE(r.rolname, 'PUBLIC'))
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_roles r ON r.oid=a.grantee
  WHERE p.oid='api.tenant_signup_request_approved_summary_v1(uuid)'::regprocedure
    AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
), 'authenticated', 'api summary execute grant is authenticated only');
SELECT ok((SELECT p.prosecdef AND p.provolatile='s'
  AND p.proconfig=ARRAY['search_path=public, extensions, pg_temp']::TEXT[]
  FROM pg_proc p WHERE p.oid='public.tenant_signup_request_approved_summary_v1(uuid)'::regprocedure),
  'public summary is STABLE security definer with fixed search_path');
SELECT ok((SELECT NOT p.prosecdef AND p.provolatile='s'
  AND p.proconfig=ARRAY['search_path=public, api, pg_temp']::TEXT[]
  FROM pg_proc p WHERE p.oid='api.tenant_signup_request_approved_summary_v1(uuid)'::regprocedure),
  'api summary is STABLE security invoker with fixed search_path');

CREATE OR REPLACE FUNCTION pg_temp.test_tenant_signup_request_approved_summary_v1()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_org UUID:=gen_random_uuid(); v_actor UUID:=gen_random_uuid(); v_foreign UUID:=gen_random_uuid();
  v_owned UUID:=gen_random_uuid(); v_null_user UUID:=gen_random_uuid(); v_foreign_req UUID:=gen_random_uuid();
  v_pending UUID:=gen_random_uuid(); v_rejected UUID:=gen_random_uuid(); v_unknown UUID:=gen_random_uuid();
  v_result JSONB; v_state TEXT; v_id UUID; v_count INT;
BEGIN
  INSERT INTO public.organizations(id,name,slug) VALUES(v_org,'Approved Summary Org','approved-summary-'||left(v_org::TEXT,8));
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id) VALUES
    (v_actor,v_org,'approved-summary-actor@example.test','Summary Actor','ops_admin','active','tenant',NULL),
    (v_foreign,v_org,'approved-summary-foreign@example.test','Summary Foreign','ops_admin','active','tenant',NULL);
  INSERT INTO public.tenant_signup_requests(
    id,status,review_decision,email,full_name,organization_name,reviewed_at,approved_organization_id,
    approved_user_id,approved_auth_user_id,invite_email_sent_at,invite_redirect_to) VALUES
    (v_owned,'approved','approved','owned@example.test','Owned','Owned Org',now(),v_org,v_actor,v_actor,now(),'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback'),
    (v_null_user,'approved','approved','owned-null@example.test','Owned Null','Owned Org',now(),v_org,NULL,v_actor,NULL,NULL),
    (v_foreign_req,'approved','approved','foreign@example.test','Foreign','Foreign Org',now(),v_org,v_foreign,v_foreign,NULL,NULL),
    (v_pending,'pending',NULL,'pending@example.test','Pending','Pending Org',NULL,NULL,NULL,v_actor,NULL,NULL),
    (v_rejected,'rejected','rejected','rejected@example.test','Rejected','Rejected Org',now(),NULL,NULL,v_actor,NULL,NULL);

  PERFORM set_config('request.jwt.claim.sub',v_actor::TEXT,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::TEXT,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result:=public.tenant_signup_request_approved_summary_v1(v_owned);
  RETURN NEXT ok(v_result->>'id'=v_owned::TEXT AND
    (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_result) key)=ARRAY[
      'approved_organization_id','approved_user_id','id','invite_email_sent_at','invite_redirect_to','reviewed_at','status'
    ]::TEXT[], 'public summary returns own row with exactly seven allowed keys');
  RETURN NEXT is(api.tenant_signup_request_approved_summary_v1(v_owned),v_result,'api wrapper returns the same summary');
  v_result:=public.tenant_signup_request_approved_summary_v1(v_null_user);
  RETURN NEXT ok(v_result?'approved_user_id' AND v_result->'approved_user_id'='null'::JSONB,
    'null approved_user_id remains allowed and present');
  SELECT count(*)::INT INTO v_count FROM public.tenant_signup_requests
   WHERE id IN(v_owned,v_null_user,v_foreign_req,v_pending,v_rejected);
  RETURN NEXT is(v_count,0,'raw signup rows remain invisible to the non-platform caller');

  v_state:=NULL;
  BEGIN PERFORM api.ui_get_resource_v1('tenant_signup_requests',v_owned);
  EXCEPTION WHEN OTHERS THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','tenant reviewer detail is denied');
  v_state:=NULL;
  BEGIN PERFORM api.ui_filter_distinct_values_v1('tenant_signup_requests','email','owned@example.test',25);
  EXCEPTION WHEN OTHERS THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','tenant reviewer distinct values are denied');
  v_state:=NULL;
  BEGIN PERFORM api.ui_list_resource_v1('tenant_signup_requests',jsonb_build_object('email','owned@example.test'),50,0,NULL::jsonb);
  EXCEPTION WHEN OTHERS THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','tenant reviewer list is denied');
  v_state:=NULL;
  BEGIN PERFORM api.ui_resource_metrics_v1('tenant_signup_requests',jsonb_build_object('email','owned@example.test'),NULL::text[]);
  EXCEPTION WHEN OTHERS THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','tenant reviewer metrics are denied');

  FOREACH v_id IN ARRAY ARRAY[v_foreign_req,v_pending,v_rejected,v_unknown] LOOP
    v_state:=NULL;
    BEGIN PERFORM public.tenant_signup_request_approved_summary_v1(v_id);
    EXCEPTION WHEN OTHERS THEN v_state:=SQLSTATE; END;
    RETURN NEXT is(v_state,'42501','foreign, non-approved, and unknown requests share the 42501 boundary');
  END LOOP;

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claim.role','anon',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',TRUE);
  EXECUTE 'SET LOCAL ROLE anon';
  v_state:=NULL;
  BEGIN PERFORM public.tenant_signup_request_approved_summary_v1(v_owned);
  EXCEPTION WHEN OTHERS THEN v_state:=SQLSTATE; END;
  RETURN NEXT is(v_state,'42501','anonymous summary call is denied with 42501');

  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.users SET access_scope_type='platform',access_scope_id=NULL WHERE id=v_actor;
  PERFORM set_config('request.jwt.claim.sub',v_actor::TEXT,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::TEXT,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*)::INT INTO v_count FROM public.tenant_signup_requests
   WHERE id IN(v_owned,v_null_user,v_foreign_req,v_pending,v_rejected);
  RETURN NEXT is(v_count,5,'platform reviewer raw queue is retained');
  RETURN NEXT is(api.ui_get_resource_v1('tenant_signup_requests',v_owned)->>'email',
    'owned@example.test','platform reviewer detail is retained');
  v_result:=api.ui_list_resource_v1('tenant_signup_requests',jsonb_build_object('email','owned@example.test'),50,0,NULL::jsonb);
  RETURN NEXT is((v_result->>'total')::INT,1,'platform reviewer filtered list is retained');
  RETURN NEXT is(v_result#>>'{items,0,email}','owned@example.test','platform reviewer list shows the selected row');
  v_result:=api.ui_resource_metrics_v1('tenant_signup_requests',jsonb_build_object('email','owned@example.test'),NULL::text[]);
  RETURN NEXT is((v_result->>'total')::INT,1,'platform reviewer filtered metrics are retained');
END;
$test$;

SELECT * FROM pg_temp.test_tenant_signup_request_approved_summary_v1();
SELECT * FROM finish();
ROLLBACK;
