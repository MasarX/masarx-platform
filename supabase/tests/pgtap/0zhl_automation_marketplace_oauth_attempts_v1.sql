-- Native Supabase fixtures only; this suite is not an offline concurrency pass.
BEGIN;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(40);

SELECT ok(
  has_function_privilege('authenticated','api.integration_connection_oauth_context_v1(uuid)','EXECUTE')
  AND has_function_privilege('authenticated','api.integration_connection_oauth_begin_v1(uuid,text,text,text,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','api.integration_connection_oauth_consume_v1(text,uuid,text,uuid,text)','EXECUTE')
  AND has_function_privilege('service_role','api.integration_connection_oauth_finish_v1(uuid,uuid,jsonb,jsonb,text,timestamptz,text)','EXECUTE')
  AND NOT has_function_privilege('service_role','api.integration_connection_oauth_context_v1(uuid)','EXECUTE'),
  'OAuth context/begin and claim/finish have disjoint browser/server grants'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.integration_connection_oauth_attempts'::regclass)
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p(privilege_name)
    WHERE has_table_privilege(r.role_name,'public.integration_connection_oauth_attempts',p.privilege_name)),
  'attempt records and Vault references are never client-readable or directly writable'
);
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='integration_connection_oauth_attempts'
  AND policyname='integration_connection_oauth_attempts_service_all' AND cmd='ALL' AND 'service_role'=ANY(roles)),
  'OAuth attempts retain a service-role policy without adding direct table privileges');
SELECT ok(EXISTS(SELECT 1 FROM public.lookup_column_contracts WHERE table_schema='public'
  AND table_name='integration_connection_oauth_attempts' AND column_name='operation'
  AND lookup_category='integration_connection_oauth_operation' AND allow_inactive=FALSE)
  AND (SELECT array_agg(lv.value::text ORDER BY lv.value) FROM public.lookup_values lv
    JOIN public.lookup_definitions d ON d.id=lv.lookup_definition_id
    WHERE d.category='integration_connection_oauth_operation' AND lv.retired_at IS NULL AND lv.status='active'
      AND (lv.effective_from IS NULL OR lv.effective_from<=now())
      AND (lv.effective_until IS NULL OR lv.effective_until>now()))=ARRAY['authorize','refresh']::TEXT[],
  'OAuth operation uses only the active authorize/refresh lookup contract');
SELECT ok(
  pg_get_indexdef('public.integration_connection_oauth_refresh_claim_once'::regclass)
    LIKE '%UNIQUE%connection_id, credential_generation%consumed_at IS NOT NULL%',
  'a database unique constraint prevents overlapping refresh claims of one generation'
);
SELECT ok(
  public.integration_connection_oauth_callback_valid_v1('https://console.example.invalid','https://console.example.invalid/api/automation-marketplace/oauth/callback')
  AND public.integration_connection_oauth_callback_valid_v1('https://console.example.invalid','https://console.example.invalid/ops/api/automation-marketplace/oauth/callback')
  AND public.integration_connection_oauth_callback_valid_v1('https://console.example.invalid','https://console.example.invalid/ops/team/api/automation-marketplace/oauth/callback')
  AND public.integration_connection_oauth_callback_valid_v1('https://console.example.invalid','https://console.example.invalid/ops+team/api/automation-marketplace/oauth/callback')
  AND public.integration_connection_oauth_callback_valid_v1('https://console.example.invalid','https://console.example.invalid/ops!$&''()*+,;=:@/team-v2._~/api/automation-marketplace/oauth/callback')
  AND public.integration_connection_oauth_callback_valid_v1('https://console.example.invalid','https://console.example.invalid/console/api/automation-marketplace/oauth/callback'),
  'root/default, nested, console, and canonical path-segment punctuation retain the exact OAuth callback suffix'
);
SELECT ok(
  NOT EXISTS(SELECT 1 FROM unnest(ARRAY[
    'https://other.example.invalid/ops/api/automation-marketplace/oauth/callback',
    'https://console.example.invalid.evil/ops/api/automation-marketplace/oauth/callback',
    'http://console.example.invalid/ops/api/automation-marketplace/oauth/callback',
    'https://console.example.invalid/ops/callback',
    'https://console.example.invalid/ops/../api/automation-marketplace/oauth/callback',
    'https://console.example.invalid/ops/./api/automation-marketplace/oauth/callback',
    'https://console.example.invalid/ops/%2e%2e/api/automation-marketplace/oauth/callback',
    'https://console.example.invalid/ops%2Bteam/api/automation-marketplace/oauth/callback',
    'https://console.example.invalid/ops+team//api/automation-marketplace/oauth/callback',
    'https://console.example.invalid/ops//api/automation-marketplace/oauth/callback',
    'https://console.example.invalid/ops\\api/automation-marketplace/oauth/callback',
    'https://console.example.invalid/ops/api/automation-marketplace/oauth/callback?extra=1',
    'https://console.example.invalid/ops/api/automation-marketplace/oauth/callback#extra',
    'https://console.example.invalid/ops/api/automation-marketplace/oauth/callback'||chr(10)
  ]) candidate WHERE public.integration_connection_oauth_callback_valid_v1('https://console.example.invalid',candidate))
  AND NOT public.integration_connection_oauth_callback_valid_v1('http://console.example.invalid','http://console.example.invalid/api/automation-marketplace/oauth/callback'),
  'wrong origins, wrong suffixes, traversal, encoding, empty segments, and URL aliases fail closed'
);

CREATE FUNCTION pg_temp.oauth_actor(p_user UUID,p_session TEXT,p_role TEXT)
RETURNS VOID LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),TRUE);
  PERFORM set_config('request.jwt.claim.role',p_role,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_strip_nulls(jsonb_build_object('sub',p_user,'role',p_role,'session_id',p_session))::text,TRUE);
  EXECUTE format('SET LOCAL ROLE %I',p_role);
END;
$function$;

CREATE FUNCTION pg_temp.oauth_policy_fixture(p_category TEXT,p_org UUID,p_user UUID,p_value JSONB)
RETURNS VOID LANGUAGE plpgsql AS $function$
DECLARE schema_version INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sg13:'||p_category||':tenant:'||p_org::text));
  SELECT MAX(version) INTO schema_version FROM public.schema_registry WHERE category=p_category AND is_active;
  PERFORM public.upsert_settings_value_v1(p_category,'tenant',p_org,p_value,schema_version,'OAuth native fixture');
END;
$function$;

CREATE FUNCTION pg_temp.test_marketplace_oauth_attempts()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $function$
DECLARE
  org UUID:=gen_random_uuid(); foreign_org UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid(); session UUID:=gen_random_uuid();
  provider UUID:=gen_random_uuid(); connection UUID:=gen_random_uuid(); foreign_connection UUID:=gen_random_uuid();
  begin_result JSONB; consumed JSONB; refreshed JSONB; policy JSONB; access_policy JSONB; scoped_policy JSONB; binding JSONB; actor_role_keys TEXT[];
  refresh_one JSONB; refresh_two JSONB; expired_vault UUID; attempt UUID; generation BIGINT;
  redirect_uri TEXT:='https://console.example.invalid/ops!$&''()*+,;=:@/team-v2._~/api/automation-marketplace/oauth/callback';
  verifier TEXT:=repeat('p',43);
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations(id,name,slug) VALUES
    (org,'OAuth Native Fixture','oauth-'||org::text),(foreign_org,'OAuth Foreign Fixture','oauth-'||foreign_org::text);
  INSERT INTO auth.users(id,aud,role,email) VALUES(actor,'authenticated','authenticated','oauth-'||actor::text||'@example.com');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
  VALUES(actor,org,'oauth-'||actor::text||'@example.com','OAuth Native Actor','ops_admin','active','tenant',NULL);
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal,not_after)
  VALUES(session,actor,clock_timestamp(),clock_timestamp(),'aal1',clock_timestamp()+INTERVAL '1 hour');
  PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['ops_admin'],actor);
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
  SELECT org,actor,r.id,actor,'{"source":"oauth-pgtap"}'::jsonb FROM public.rbac_roles r WHERE r.organization_id=org AND r.key='ops_admin' ON CONFLICT DO NOTHING;
  PERFORM pg_advisory_xact_lock(hashtext('sg13:access_control_policy:tenant:'||org::text));
  access_policy:=public.resolve_settings_merged('access_control_policy','tenant',org);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(access_policy->'roles') r WHERE r->>'key'='automation_marketplace_installer') THEN
    RAISE EXCEPTION 'Fixture marketplace policy role missing';
  END IF;
  SELECT sv.value INTO scoped_policy FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
   WHERE s.category='access_control_policy' AND s.scope_type='tenant' AND s.scope_id=org;
  scoped_policy:=COALESCE(scoped_policy,'{}'::jsonb);
  SELECT array_agg(DISTINCT role_key ORDER BY role_key) INTO actor_role_keys
   FROM unnest(public.resolve_role_keys_v1(access_policy,actor,'ops_admin')||ARRAY['automation_marketplace_installer']) r(role_key);
  scoped_policy:=jsonb_set(scoped_policy,'{assignments}',COALESCE(scoped_policy->'assignments','{}'::jsonb)||jsonb_build_object(
   'user_id',COALESCE(scoped_policy#>'{assignments,user_id}','{}'::jsonb)||jsonb_build_object(actor::text,to_jsonb(actor_role_keys))),TRUE);
  PERFORM pg_temp.oauth_policy_fixture('access_control_policy',org,actor,scoped_policy);
  RETURN NEXT ok('ops_admin'=ANY(actor_role_keys)
    AND EXISTS(SELECT 1 FROM public.users WHERE id=actor AND organization_id=org AND access_scope_type='tenant' AND access_scope_id IS NULL),
    'OAuth fixture preserves its baseline role and tenant user scope contract');
  INSERT INTO public.providers(id,organization_id,name,provider_type,enabled) VALUES(provider,org,'oauth_fixture','delivery',TRUE);
  INSERT INTO public.integration_connections(id,organization_id,owner_scope_type,owner_scope_id,provider_id,provider_key,name,auth_type,config)
  VALUES(connection,org,'tenant',org,provider,'oauth_fixture','Native OAuth','oauth2_authorization_code_pkce',
    '{"token_url":"https://untrusted.example.invalid/token"}'::jsonb);
  INSERT INTO public.integration_connections(id,organization_id,owner_scope_type,owner_scope_id,provider_key,name,auth_type)
  VALUES(foreign_connection,foreign_org,'tenant',foreign_org,'oauth_fixture','Foreign OAuth','oauth2_authorization_code_pkce');
  policy:=public.automation_marketplace_resolve_policy_v1('tenant',org,org);
  access_policy:=public.resolve_settings_merged('access_control_policy','tenant',org);

  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  RETURN NEXT ok(public.user_has_capability_v1('automation_marketplace.manage_connections')
    AND NOT public.user_has_capability_v1('automation_marketplace.publish'),
    'explicit installer policy assignment grants connection management without publisher capability');
  RETURN NEXT is(api.integration_connection_oauth_context_v1(connection),' {"configured":false}'::jsonb,'default owner policy leaves OAuth unconfigured');
  PERFORM pg_temp.oauth_actor(actor,gen_random_uuid()::text,'authenticated');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_context_v1(%L::uuid)',connection),'42501','OAuth authorization denied','a plausible JWT without a live session cannot start OAuth');
  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_context_v1(%L::uuid)',foreign_connection),'42501','OAuth authorization denied','another tenant connection is denied');

  EXECUTE 'SET LOCAL ROLE postgres';
  binding:=jsonb_build_object('provider_key','oauth_fixture','authorization_url','https://oauth.example.invalid/authorize',
    'token_url','https://oauth.example.invalid/token','client_id','synthetic-public-client','scopes',jsonb_build_array('read'),
    'redirect_uri',redirect_uri,'console_origin','https://console.example.invalid');
  policy:=jsonb_set(policy,'{oauth,providers}',jsonb_build_object('oauth_fixture',binding),TRUE);
  PERFORM pg_temp.oauth_policy_fixture('automation_marketplace_policy',org,actor,policy);
  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  RETURN NEXT is(api.integration_connection_oauth_context_v1(connection)#>>'{provider_binding,token_url}','https://oauth.example.invalid/token','endpoints come from trusted current policy, never connection metadata');
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'authorize',repeat('a',64),verifier,redirect_uri);
  RETURN NEXT ok((begin_result->>'expires_at')::timestamptz<=clock_timestamp()+INTERVAL '5 minutes'
    AND NOT begin_result?'pkce_verifier','begin returns only the bounded attempt envelope');
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT pkce_verifier_vault_id INTO expired_vault FROM public.integration_connection_oauth_attempts WHERE id=(begin_result->>'attempt_id')::uuid;
  RETURN NEXT throws_ok(format($sql$
    INSERT INTO public.integration_connection_oauth_attempts(id,connection_id,organization_id,owner_scope_type,owner_scope_id,
      actor_user_id,actor_session_id,operation,state_hash,credential_generation,provider_binding,binding_hash,pkce_verifier_vault_id,created_at,expires_at)
    SELECT gen_random_uuid(),connection_id,organization_id,owner_scope_type,owner_scope_id,actor_user_id,actor_session_id,
      'invalid',repeat('f',64),credential_generation,provider_binding,binding_hash,pkce_verifier_vault_id,created_at,expires_at
    FROM public.integration_connection_oauth_attempts WHERE id=%L::uuid
    $sql$,begin_result->>'attempt_id'),'23514',
    'Invalid lookup value for public.integration_connection_oauth_attempts.operation: "invalid" is not an allowed value for category "integration_connection_oauth_operation"',
    'the actual lookup trigger rejects invalid OAuth operation on an otherwise valid attempt');
  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('a',64),actor,session::text,connection,'authorize'),'42501',NULL,'browser roles cannot consume Vault material');
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('a',64),gen_random_uuid(),session::text,connection,'authorize'),'55000','OAuth attempt invalid','claim is bound to the original actor');
  consumed:=api.integration_connection_oauth_consume_v1(repeat('a',64),actor,session::text,connection,'authorize');
  RETURN NEXT ok(consumed->>'pkce_verifier'=verifier AND consumed->>'claim_token' IS NOT NULL AND NOT consumed?'refresh_token','a valid authorization claim returns only its own verifier');
  RETURN NEXT ok(current_setting('request.jwt.claim.sub',TRUE)='' AND current_setting('request.jwt.claim.role',TRUE)='service_role'
    AND current_setting('request.jwt.claims',TRUE)::jsonb='{"role":"service_role"}'::jsonb,'all original service JWT settings are restored after actor evaluation');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM vault.secrets WHERE id=expired_vault)
    AND EXISTS(SELECT 1 FROM public.integration_connection_oauth_attempts WHERE id=(consumed->>'attempt_id')::uuid AND pkce_verifier_vault_id IS NULL),
    'consume erases only its own verifier and clears the sealed reference in the same transaction');
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('a',64),actor,session::text,connection,'authorize'),'55000','OAuth attempt invalid','consumed authorization state cannot replay');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_finish_v1(%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,%L,NULL,NULL)',consumed->>'attempt_id',gen_random_uuid(),'{"access_token":"synthetic-token"}','{}','ready'),'55000','OAuth completion conflict','completion requires the exact claim token');
  PERFORM api.integration_connection_oauth_finish_v1((consumed->>'attempt_id')::uuid,(consumed->>'claim_token')::uuid,
    '{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","token_type":"Bearer"}'::jsonb,'{"token_type":"Bearer","access_token":"must-not-persist"}'::jsonb,'ready',clock_timestamp()+INTERVAL '1 hour',NULL);
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.integration_connections c JOIN public.provider_auth_configs a ON a.id=c.runtime_auth_config_id
    WHERE c.id=connection AND c.credential_generation=1 AND c.status='ready' AND a.credentials_vault_id=c.credentials_vault_id
      AND NOT c.oauth_metadata?'access_token'),'successful completion advances generation and synchronizes the runtime Vault pointer without metadata secrets');
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_finish_v1(%L::uuid,%L::uuid,NULL,%L::jsonb,%L,NULL,%L)',consumed->>'attempt_id',consumed->>'claim_token','{}','reauth_required','token_exchange_failed'),'55000','OAuth completion conflict','completed attempts cannot replay');

  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  refresh_one:=api.integration_connection_oauth_begin_v1(connection,'refresh',repeat('b',64),NULL,redirect_uri);
  refresh_two:=api.integration_connection_oauth_begin_v1(connection,'refresh',repeat('c',64),NULL,redirect_uri);
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  refreshed:=api.integration_connection_oauth_consume_v1(repeat('b',64),actor,session::text,connection,'refresh');
  RETURN NEXT ok(refreshed->>'refresh_token'='synthetic-refresh' AND NOT refreshed?'pkce_verifier','refresh claims expose only the bound generation token');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('c',64),actor,session::text,connection,'refresh'),'55000','OAuth attempt invalid','a second overlapping attempt cannot claim the same refresh generation');
  PERFORM api.integration_connection_oauth_finish_v1((refreshed->>'attempt_id')::uuid,(refreshed->>'claim_token')::uuid,
    '{"access_token":"synthetic-access-2","refresh_token":"synthetic-refresh-2"}'::jsonb,'{}'::jsonb,'ready',NULL,NULL);
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.integration_connections c JOIN vault.decrypted_secrets s ON s.id=c.credentials_vault_id
    WHERE c.id=connection AND c.credential_generation=2 AND s.decrypted_secret::jsonb->>'refresh_token'='synthetic-refresh-2'),'refresh rotation replaces Vault credentials and advances generation');

  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'refresh',repeat('5',64),NULL,redirect_uri);
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  refreshed:=api.integration_connection_oauth_consume_v1(repeat('5',64),actor,session::text,connection,'refresh');
  PERFORM api.integration_connection_oauth_finish_v1((refreshed->>'attempt_id')::uuid,(refreshed->>'claim_token')::uuid,
    NULL,'{}'::jsonb,'reauth_required',NULL,'token_exchange_failed');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.integration_connections c JOIN public.provider_auth_configs a ON a.id=c.runtime_auth_config_id
    WHERE c.id=connection AND c.credential_generation=3 AND c.status='reauth_required' AND a.credentials_vault_id IS NULL
      AND a.credentials='{}'::jsonb AND a.expires_at<=clock_timestamp()),'refresh failure requires reauthorization and invalidates the existing runtime pointer without writing a new secret');

  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'authorize',repeat('d',64),verifier,redirect_uri);
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT pkce_verifier_vault_id INTO expired_vault FROM public.integration_connection_oauth_attempts WHERE id=(begin_result->>'attempt_id')::uuid;
  UPDATE public.integration_connection_oauth_attempts SET created_at=created_at-INTERVAL '10 minutes',expires_at=expires_at-INTERVAL '10 minutes' WHERE id=(begin_result->>'attempt_id')::uuid;
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('d',64),actor,session::text,connection,'authorize'),'55000','OAuth attempt invalid','expired authorization cannot release a verifier');
  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'authorize',repeat('e',64),verifier,redirect_uri);
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM vault.secrets WHERE id=expired_vault),'a new begin cleans expired verifiers for the same actor and connection');
  UPDATE public.integration_connections SET credential_generation=credential_generation+1 WHERE id=connection;
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('e',64),actor,session::text,connection,'authorize'),'55000','OAuth attempt invalid','credential rotation between begin and consume wins');

  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'authorize',repeat('f',64),verifier,redirect_uri);
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM pg_temp.oauth_policy_fixture('automation_marketplace_policy',org,actor,jsonb_set(policy,'{oauth,providers,oauth_fixture,token_url}','"https://changed.example.invalid/token"'));
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('f',64),actor,session::text,connection,'authorize'),'55000','OAuth attempt invalid','trusted provider configuration changes invalidate pending authorization');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM pg_temp.oauth_policy_fixture('automation_marketplace_policy',org,actor,policy);
  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'authorize',repeat('1',64),verifier,redirect_uri);
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM pg_temp.oauth_policy_fixture('access_control_policy',org,actor,jsonb_set(access_policy,'{denies}',
    jsonb_build_array(jsonb_build_object('capability_key','automation_marketplace.manage_connections','scope_type','tenant','scope_id',org)),TRUE));
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('1',64),actor,session::text,connection,'authorize'),'55000','OAuth attempt invalid','capability revocation is rechecked at privileged consume');
  RETURN NEXT ok(current_setting('request.jwt.claim.role',TRUE)='service_role' AND current_setting('request.jwt.claim.sub',TRUE)='','failed actor checks also restore legacy claim settings');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM pg_temp.oauth_policy_fixture('access_control_policy',org,actor,access_policy);

  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'authorize',repeat('2',64),verifier,redirect_uri);
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  consumed:=api.integration_connection_oauth_consume_v1(repeat('2',64),actor,session::text,connection,'authorize');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM pg_temp.oauth_policy_fixture('automation_marketplace_policy',org,actor,jsonb_set(policy,'{oauth,providers,oauth_fixture,client_id}','"changed-public-client"'));
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_finish_v1(%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,%L,NULL,NULL)',consumed->>'attempt_id',consumed->>'claim_token','{"access_token":"synthetic-stale-token"}','{}','ready'),'55000','OAuth completion conflict','finish rechecks trusted provider binding after the network exchange');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM pg_temp.oauth_policy_fixture('automation_marketplace_policy',org,actor,policy);
  PERFORM pg_temp.oauth_policy_fixture('access_control_policy',org,actor,jsonb_set(access_policy,'{denies}',
    jsonb_build_array(jsonb_build_object('capability_key','automation_marketplace.manage_connections','scope_type','tenant','scope_id',org)),TRUE));
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_finish_v1(%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,%L,NULL,NULL)',consumed->>'attempt_id',consumed->>'claim_token','{"access_token":"synthetic-stale-token"}','{}','ready'),'55000','OAuth completion conflict','finish rechecks capability revocation after the network exchange');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM pg_temp.oauth_policy_fixture('access_control_policy',org,actor,access_policy);
  UPDATE public.integration_connections SET status='revoked',revoked_at=clock_timestamp(),credential_generation=credential_generation+1 WHERE id=connection;
  SELECT credential_generation INTO generation FROM public.integration_connections WHERE id=connection;
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_finish_v1(%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,%L,NULL,NULL)',consumed->>'attempt_id',consumed->>'claim_token','{"access_token":"synthetic-stale-token"}','{}','ready'),'55000','OAuth completion conflict','revocation after consume wins over delayed token completion');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.integration_connections WHERE id=connection AND status='revoked' AND credential_generation=generation),'failed completion never resurrects or overwrites a revoked connection');
  UPDATE public.integration_connections SET status='ready',revoked_at=NULL WHERE id=connection;
  PERFORM pg_temp.oauth_actor(actor,session::text,'authenticated');
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'authorize',repeat('3',64),verifier,redirect_uri);
  begin_result:=api.integration_connection_oauth_begin_v1(connection,'authorize',repeat('4',64),verifier,redirect_uri);
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  consumed:=api.integration_connection_oauth_consume_v1(repeat('4',64),actor,session::text,connection,'authorize');
  EXECUTE 'SET LOCAL ROLE postgres';
  DELETE FROM auth.sessions WHERE id=session;
  PERFORM pg_temp.oauth_actor(NULL,NULL,'service_role');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_consume_v1(%L,%L::uuid,%L,%L::uuid,%L)',repeat('3',64),actor,session::text,connection,'authorize'),'55000','OAuth attempt invalid','logout session revocation wins over stored callback state');
  RETURN NEXT throws_ok(format('SELECT api.integration_connection_oauth_finish_v1(%L::uuid,%L::uuid,%L::jsonb,%L::jsonb,%L,NULL,NULL)',consumed->>'attempt_id',consumed->>'claim_token','{"access_token":"synthetic-stale-token"}','{}','ready'),'55000','OAuth completion conflict','finish also rechecks live session after a successful claim');
  EXECUTE 'SET LOCAL ROLE postgres';
END;
$function$;

SELECT * FROM pg_temp.test_marketplace_oauth_attempts();
SELECT * FROM finish();
ROLLBACK;
