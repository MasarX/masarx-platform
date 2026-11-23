-- Native effective-definition and credential-lineage proof. UNRUN without the native DB lane.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT no_plan();

CREATE FUNCTION pg_temp.marketplace_auth_isolation()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  org UUID:=gen_random_uuid(); provider_a UUID:=gen_random_uuid(); provider_b UUID:=gen_random_uuid();
  legacy_a UUID:=gen_random_uuid(); legacy_b UUID:=gen_random_uuid(); job UUID:=gen_random_uuid();
  connection UUID; owned_a UUID; owned_b UUID; result JSONB; definition TEXT; query TEXT; implicit_count INT;
  lease_token UUID:=gen_random_uuid(); leased_header TEXT;
  service_probe CONSTANT TEXT :=
    'DO $probe$ BEGIN SET LOCAL ROLE service_role; PERFORM %s; RESET ROLE; END; $probe$';
BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',TRUE);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  INSERT INTO public.organizations(id,name,slug) VALUES(org,'Auth isolation fixture','auth-isolation-'||org);
  INSERT INTO public.providers(id,organization_id,name,provider_type,enabled) VALUES
    (provider_a,org,'Auth isolation A','http',TRUE),(provider_b,org,'Auth isolation B','http',TRUE);
  INSERT INTO public.provider_auth_configs(id,provider_id,auth_type,credentials,created_at) VALUES
    (legacy_a,provider_a,'api_key','{"api_key":"synthetic-legacy-a"}',clock_timestamp()-INTERVAL '1 day'),
    (legacy_b,provider_b,'api_key','{"api_key":"synthetic-legacy-b"}',clock_timestamp()-INTERVAL '1 day');
  RETURN NEXT ok(NOT (SELECT marketplace_explicit_only FROM public.provider_auth_configs WHERE id=legacy_a),'preexisting/default auth rows remain implicitly eligible');
  result:=public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=org,
    p_provider_id:=provider_a,p_name:='Owned credential',p_secret_payload:='{"api_key":"synthetic-owned-a"}');
  connection:=(result->>'connection_id')::uuid;
  SELECT runtime_auth_config_id INTO owned_a FROM public.integration_connections WHERE id=connection;
  RETURN NEXT ok((SELECT marketplace_explicit_only FROM public.provider_auth_configs WHERE id=owned_a),'actual connection sync durably marks its newer runtime credential');
  INSERT INTO public.outbound_calls(id,call_type,target_type,target_id,method,url,headers,body,context)
    VALUES(job,'provider_api','provider',provider_a,'POST','https://provider.example.invalid/operation','{}','{}',
      '{"auth":{"mode":"api_key_header","auth_type":"api_key","header":"x-api-key","credential_key":"api_key"}}');
  RETURN NEXT is(public.get_job_call_spec(job)#>>'{headers,x-api-key}','synthetic-legacy-a','actual ingress-wrapped dispatch ignores newer owned credentials implicitly');

  UPDATE public.outbound_calls
  SET status='in_progress_edge', edge_lease_token=lease_token, lease_expires_at=now()-INTERVAL '1 second'
  WHERE id=job;
  RETURN NEXT throws_ok(format(service_probe,format('public.get_job_call_spec(%L::uuid)',job)),'42501',NULL,
    'service_role cannot execute the retired public outbound spec');
  RETURN NEXT throws_ok(format(service_probe,format('api.get_job_call_spec(%L::uuid)',job)),'42501',NULL,
    'service_role cannot execute the retired API outbound spec');
  RETURN NEXT throws_ok(format(service_probe,format('api.get_claimed_edge_job_call_spec_v1(%L::uuid,%L::uuid)',job,lease_token)),
    'P0001',format('get_claimed_edge_job_call_spec_v1: active lease for job %s not found',job),
    'service_role cannot resolve marketplace credentials with an expired lease token');

  UPDATE public.outbound_calls SET lease_expires_at=now()+INTERVAL '5 minutes' WHERE id=job;
  RETURN NEXT throws_ok(format(service_probe,format('api.get_claimed_edge_job_call_spec_v1(%L::uuid,%L::uuid)',job,job)),
    'P0001',format('get_claimed_edge_job_call_spec_v1: active lease for job %s not found',job),
    'service_role cannot resolve marketplace credentials with a mismatched lease token');
  SET LOCAL ROLE service_role;
  leased_header:=api.get_claimed_edge_job_call_spec_v1(job,lease_token)#>>'{headers,x-api-key}';
  RESET ROLE;
  RETURN NEXT is(leased_header,public.get_job_call_spec(job)#>>'{headers,x-api-key}',
    'service_role resolves the same marketplace credential through the fenced API with the active lease');

  UPDATE public.outbound_calls SET context=jsonb_set(context,'{auth,auth_config_id}',to_jsonb(owned_a::text),TRUE) WHERE id=job;
  RETURN NEXT is(public.get_job_call_spec(job)#>>'{headers,x-api-key}','synthetic-owned-a','explicit installer-owned credential selection still works');
  PERFORM public.integration_connection_rotate_v1(connection,'{"api_key":"synthetic-rotated"}',FALSE,NULL);
  RETURN NEXT is(public.get_job_call_spec(job)#>>'{headers,x-api-key}','synthetic-rotated','explicit selection follows actual credential rotation');
  UPDATE public.outbound_calls SET context=context #- '{auth,auth_config_id}' WHERE id=job;
  RETURN NEXT is(public.get_job_call_spec(job)#>>'{headers,x-api-key}','synthetic-legacy-a','rotation does not change an unrelated implicit default');

  definition:=pg_get_functiondef('public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure);
  query:=substring(definition FROM 'SELECT count\(\*\) INTO v_auth_config_count[[:space:]]+FROM public.provider_auth_configs[^;]+;');
  IF query IS NULL THEN RAISE EXCEPTION 'Expected effective gateway selector missing'; END IF;
  query:=replace(replace(replace(query,'INTO v_auth_config_count',''),'v_provider_id',quote_literal(provider_a::text)||'::uuid'),'v_auth_type',quote_literal('api_key'));
  EXECUTE query INTO implicit_count;
  RETURN NEXT is(implicit_count,1,'actual effective gateway uniqueness selector excludes the owned credential');

  PERFORM public.integration_connection_upsert_v1(p_connection_id:=connection,p_provider_id:=provider_b,
    p_secret_payload:='{"api_key":"synthetic-owned-b"}');
  SELECT runtime_auth_config_id INTO owned_b FROM public.integration_connections WHERE id=connection;
  RETURN NEXT ok(owned_a<>owned_b,'actual provider change creates a separate runtime binding');
  RETURN NEXT ok((SELECT marketplace_explicit_only AND credentials='{}'::jsonb AND credentials_vault_id IS NULL FROM public.provider_auth_configs WHERE id=owned_a),'unlinked old-provider credential stays marked and invalidated');
  RETURN NEXT is(public.get_job_call_spec(job)#>>'{headers,x-api-key}','synthetic-legacy-a','orphaned owned row cannot shadow the old provider default');
  UPDATE public.outbound_calls SET target_id=provider_b WHERE id=job;
  RETURN NEXT is(public.get_job_call_spec(job)#>>'{headers,x-api-key}','synthetic-legacy-b','new provider default is not replaced by the scoped connection');
  PERFORM public.integration_connection_revoke_v1(connection,NULL);
  RETURN NEXT ok((SELECT marketplace_explicit_only AND credentials='{}'::jsonb AND credentials_vault_id IS NULL FROM public.provider_auth_configs WHERE id=owned_b),'revocation never turns an owned credential into an implicit default');
  RETURN NEXT is(public.get_job_call_spec(job)#>>'{headers,x-api-key}','synthetic-legacy-b','revoked owned row cannot shadow the legacy default');
  UPDATE public.outbound_calls SET context=jsonb_set(context,'{auth,auth_config_id}',to_jsonb(owned_b::text),TRUE) WHERE id=job;
  RETURN NEXT throws_ok(format('SELECT public.get_job_call_spec(%L::uuid)',job),'P0001',NULL,'revoked explicit credential is unusable instead of silently falling back');
END;
$test$;
SELECT * FROM pg_temp.marketplace_auth_isolation();
SELECT ok(pg_get_functiondef('public.get_job_call_spec(uuid)'::regprocedure) LIKE '%get_job_call_spec_without_ingress_vault_v1%','current ingress wrapper remains in place');
SELECT ok(
  NOT has_function_privilege('service_role','public.get_job_call_spec(uuid)','EXECUTE')
  AND NOT has_function_privilege('service_role','api.get_job_call_spec(uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.get_job_call_spec(uuid)','EXECUTE'),
  'unfenced marketplace dispatch grants exclude service_role and authenticated');
SELECT * FROM finish();
ROLLBACK;
