-- Test Suite: UI security resources (registry + RLS)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(22);

SELECT has_table('public', 'provider_auth_configs', 'provider_auth_configs table exists');
SELECT has_table('public', 'audit_table_changes', 'audit_table_changes table exists');

SELECT ok(
  (SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'provider_auth_configs'),
  'RLS enabled on provider_auth_configs'
);

SELECT ok(
  (SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'audit_table_changes'),
  'RLS enabled on audit_table_changes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_policies pol
     WHERE pol.schemaname = 'public'
       AND pol.tablename = 'provider_auth_configs'
       AND pol.policyname = 'provider_auth_configs_select'
  ),
  'provider_auth_configs_select policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_policies pol
     WHERE pol.schemaname = 'public'
       AND pol.tablename = 'audit_table_changes'
       AND pol.policyname = 'audit_table_changes_select'
  ),
  'audit_table_changes_select policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'provider_auth_configs'
       )
  ),
  'ui_read_registry includes provider_auth_configs'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'audit_table_changes'
       )
  ),
  'ui_read_registry includes audit_table_changes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resources'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'token_rotation_requests'
       )
  ),
  'ui_read_registry includes token_rotation_requests'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'access_control_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resource_map'
       AND cached_value->'resource_map' ? 'provider_auth_configs'
  ),
  'access_control_policy resource_map includes provider_auth_configs'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'access_control_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resource_map'
       AND cached_value->'resource_map' ? 'audit_table_changes'
  ),
  'access_control_policy resource_map includes audit_table_changes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'access_control_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value ? 'resource_map'
       AND cached_value->'resource_map' ? 'token_rotation_requests'
  ),
  'access_control_policy resource_map includes token_rotation_requests'
);

SELECT ok((SELECT count(*)=1 AND bool_and(
  CASE WHEN jsonb_typeof(resource->'select')='array' THEN
    jsonb_array_length(resource->'select')>0
    AND NOT (resource->'select' ?| ARRAY['credentials','credentials_vault_id','*'])
  ELSE FALSE END)
 FROM public.settings s CROSS JOIN LATERAL jsonb_array_elements(s.cached_value->'resources') resource
 WHERE s.category='ui_read_registry' AND s.scope_type='global' AND s.scope_id IS NULL
   AND resource->>'key'='provider_auth_configs'),
 'provider auth registry has one explicit safe projection without credential columns or wildcard');

CREATE FUNCTION pg_temp.f267_provider_auth_projection() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
 org UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid(); provider UUID:=gen_random_uuid(); auth_config UUID:=gen_random_uuid();
 secret UUID; fake TEXT:='QA-NOT-A-REAL-SECRET-'||gen_random_uuid();
 role_key TEXT:='qa_f267_'||replace(gen_random_uuid()::text,'-','');
 policy JSONB; schema_version INT; result JSONB; api_schema TEXT;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 INSERT INTO public.organizations(id,name,slug,billing_status)
 VALUES(org,'F267 provider auth projection','f267-'||org,'active');
 INSERT INTO public.providers(id,organization_id,name,provider_type,enabled)
 VALUES(provider,org,'F267 fake-credential provider','http',true);
 -- Existing outbound secret-hygiene fixture seam; no real credentials, no network, outer rollback.
 secret:=vault.create_secret(jsonb_build_object('api_key',fake)::text,
   'provider_auth_configs/'||auth_config,'F267 rollback-only fake secret',NULL);
 INSERT INTO public.provider_auth_configs(id,provider_id,auth_type,credentials_vault_id,credentials)
 VALUES(auth_config,provider,'api_key',secret,NULL);
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
 VALUES(actor,org,'f267-'||actor||'@example.test','F267 provider reader','ops_admin','active','tenant',NULL);
 PERFORM public.provision_rbac_roles_from_templates_v1(org,ARRAY['ops_admin'],actor);
 INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
 SELECT org,actor,id,actor,'{"source":"pgtap-f267-row45"}' FROM public.rbac_roles
 WHERE organization_id=org AND key='ops_admin';
 SELECT p.policy,(SELECT version FROM public.schema_registry WHERE category='access_control_policy'
   AND is_active ORDER BY version DESC LIMIT 1) INTO STRICT policy,schema_version
 FROM public.resolve_access_control_policy_v1('tenant',org,FALSE) p;
 policy:=jsonb_set(policy,'{roles}',(policy->'roles')||jsonb_build_array(
   jsonb_build_object('key',role_key,'capability_keys',jsonb_build_array('provider_auth.read'))));
 policy:=jsonb_set(policy,'{assignments}',COALESCE(policy->'assignments','{}')||
   jsonb_build_object('user_id',COALESCE(policy#>'{assignments,user_id}','{}')||
     jsonb_build_object(actor::text,jsonb_build_array(role_key))));
 PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,policy,schema_version,'F267 safe projection reader');
 SET CONSTRAINTS ALL IMMEDIATE;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
   'organization_id',org,'scope_type','tenant','scope_id',org)::text,true);
 SET LOCAL ROLE authenticated;
 RETURN NEXT ok(current_user='authenticated' AND auth.uid()=actor
   AND public.user_has_capability_v1('provider_auth.read','tenant',org)
   AND NOT public.user_has_capability_v1('provider_auth.write','tenant',org),
   'provider metadata reader is authenticated with narrow read authority');
 FOREACH api_schema IN ARRAY ARRAY['public','api'] LOOP
 EXECUTE format('SELECT %I.ui_list_resource_v1($1,$2,$3,$4,$5)',api_schema)
 INTO result USING 'provider_auth_configs',jsonb_build_object('provider_id',provider),50,0,NULL::jsonb;
 RETURN NEXT ok(jsonb_array_length(result->'items')=1
   AND result#>>'{items,0,id}'=auth_config::text
   AND result#>>'{items,0,provider_id}'=provider::text AND result#>>'{items,0,auth_type}'='api_key',
   api_schema||' provider auth list returns positive safe metadata');
 RETURN NEXT ok(jsonb_typeof(result->'keys')='array'
   AND NOT (result->'keys' ?| ARRAY['credentials','credentials_vault_id'])
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') item
     WHERE item ?| ARRAY['credentials','credentials_vault_id'])
   AND position(fake IN result::text)=0 AND position(secret::text IN result::text)=0,
   api_schema||' provider auth list rows and keys exclude credential fields and fake material');
 EXECUTE format('SELECT %I.ui_get_resource_v1($1,$2)',api_schema) INTO result USING 'provider_auth_configs',auth_config;
 RETURN NEXT ok(result->>'id'=auth_config::text AND result->>'provider_id'=provider::text
   AND result->>'auth_type'='api_key',api_schema||' provider auth detail returns positive safe metadata');
 RETURN NEXT ok(NOT (result ?| ARRAY['credentials','credentials_vault_id'])
   AND position(fake IN result::text)=0 AND position(secret::text IN result::text)=0,
   api_schema||' provider auth detail excludes credential fields and fake material');
 END LOOP;
 RESET ROLE;
 SET CONSTRAINTS ALL IMMEDIATE;
END;
$test$;
SELECT * FROM pg_temp.f267_provider_auth_projection();

SELECT finish();

ROLLBACK;
