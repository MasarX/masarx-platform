SET search_path TO public,pgtap,extensions,pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);
CREATE FUNCTION pg_temp.f725_public_entry_proof() RETURNS SETOF TEXT LANGUAGE plpgsql AS $proof$
DECLARE
 org UUID:=gen_random_uuid();
 other_org UUID:=gen_random_uuid();
 entry TEXT:='f725-'||gen_random_uuid();
 policy JSONB;
 policy_version INT;
 base_entry JSONB;
 variant JSONB;
 result JSONB;
 request JSONB;
 v_email TEXT:='f725-'||gen_random_uuid()||'@example.test';
BEGIN
 INSERT INTO public.organizations(id,name,slug) VALUES
  (org,'F725 owned public entry','f725-'||org),
  (other_org,'F725 other entry','f725-'||other_org);
 SELECT sv.value,sv.schema_version INTO policy,policy_version FROM public.settings s
 JOIN public.settings_versions sv ON sv.id=s.settings_version_id
 WHERE s.category='marketplace_compliance_policy' AND s.scope_type='global' AND s.scope_id IS NULL;
 base_entry:=jsonb_build_object('enabled',true,'public',true,'organization_id',org,'participant_type_key','freelancer_driver');
 policy:=jsonb_set(policy,'{public_entries}',jsonb_build_object(entry,base_entry));
 PERFORM public.upsert_settings_value_v1('marketplace_compliance_policy','global',NULL,policy,policy_version,'F725 rollback public-entry fixture');
 -- A tenant override cannot become the public-entry authority.
 PERFORM public.upsert_settings_value_v1('marketplace_compliance_policy','tenant',other_org,
   jsonb_set(policy,ARRAY['public_entries',entry,'organization_id'],to_jsonb(other_org)),policy_version,'F725 rollback foreign override');
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 EXECUTE 'SET LOCAL ROLE service_role';
 result:=api.marketplace_public_entry_resolve_v1(entry,'freelancer_driver');
 RETURN NEXT is(result->>'organization_id',org::text,'global configured entry is authoritative');
 RETURN NEXT is(result->>'organization_slug','f725-'||org,'slug is canonical organization readback');
 RETURN NEXT is(api.marketplace_public_entry_resolve_v1(entry,'provider_tenant')->>'ok','false','participant mismatch denied');
 RETURN NEXT is(api.marketplace_public_entry_resolve_v1('unknown','freelancer_driver')->>'ok','false','unknown entry denied');
 RETURN NEXT is(api.marketplace_public_entry_resolve_v1(NULL,'freelancer_driver')->>'ok','false','missing entry denied');
 EXECUTE 'SET LOCAL ROLE postgres';
 FOREACH variant IN ARRAY ARRAY[
  'null'::jsonb,'[]'::jsonb,'"scalar"'::jsonb,
  base_entry||'{"enabled":false}',base_entry||'{"enabled":"true"}',
  base_entry||'{"public":false}',base_entry||'{"organization_id":"invalid"}',
  base_entry||jsonb_build_object('organization_id',gen_random_uuid()),
  base_entry||'{"private_token":"forbidden"}'
 ] LOOP
  PERFORM public.upsert_settings_value_v1('marketplace_compliance_policy','global',NULL,
    jsonb_set(policy,ARRAY['public_entries',entry],variant),policy_version,'F725 rollback malformed route fixture');
  RETURN NEXT is(public.marketplace_public_entry_resolve_v1(entry,'freelancer_driver')->>'ok','false','malformed or disabled entry denied');
 END LOOP;
 PERFORM public.upsert_settings_value_v1('marketplace_compliance_policy','global',NULL,policy,policy_version,'F725 restore valid fixture');
 RETURN NEXT ok(NOT has_function_privilege('anon','api.marketplace_public_entry_resolve_v1(text,text)','EXECUTE'),'anonymous cannot call resolver');
 RETURN NEXT ok(NOT has_function_privilege('authenticated','api.marketplace_public_entry_resolve_v1(text,text)','EXECUTE'),'authenticated cannot call resolver');
 RETURN NEXT ok(NOT has_function_privilege('authenticated','public.marketplace_public_entry_resolve_v1(text,text)','EXECUTE'),'public implementation has same boundary');
 RETURN NEXT ok(has_function_privilege('service_role','api.marketplace_public_entry_resolve_v1(text,text)','EXECUTE'),'service API contract available');
 -- Existing create sink remains responsible for pending request and review lineage.
 EXECUTE 'SET LOCAL ROLE service_role';
 request:=public.marketplace_participant_request_create_v1(
   p_requested_participant_type_key:='freelancer_driver',p_email:=v_email,p_full_name:='F725 proof',
   p_organization_name:='F725 proof',p_requested_organization_id:=org,p_turnstile_verified:=true);
 RETURN NEXT is(request->>'ok','true','scoped request succeeds through existing sink');
 RETURN NEXT is((SELECT r.requested_organization_id::text FROM public.marketplace_participant_requests r WHERE r.id=(request->>'id')::uuid),org::text,'request keeps exact mapped tenant');
 RETURN NEXT is((SELECT r.status FROM public.marketplace_participant_requests r WHERE r.id=(request->>'id')::uuid),'pending','submission does not approve');
 RETURN NEXT is((SELECT count(*) FROM public.users u WHERE u.email=v_email),0::bigint,'submission creates no user membership');
 EXECUTE 'SET LOCAL ROLE postgres';
END;
$proof$;
SELECT * FROM pg_temp.f725_public_entry_proof();
SELECT * FROM finish();
ROLLBACK;
