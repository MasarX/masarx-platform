BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(40);

SELECT has_function('public', 'ui_retire_provider_auth_config_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'], 'public retirement command exists');
SELECT has_function('api', 'ui_retire_provider_auth_config_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'], 'browser retirement command exists');
SELECT function_privs_are('public', 'ui_retire_provider_auth_config_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'], 'authenticated', ARRAY['EXECUTE'],
  'authenticated may execute the public command');
SELECT function_privs_are('api', 'ui_retire_provider_auth_config_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'], 'authenticated', ARRAY['EXECUTE'],
  'authenticated may execute the browser command');
SELECT ok(NOT has_function_privilege('anon', 'api.ui_retire_provider_auth_config_v1(text,text,text[],text,integer,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.ui_retire_provider_auth_config_v1(text,text,text[],text,integer,jsonb)', 'EXECUTE'),
  'anonymous and service execution is not implicitly granted');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'ui_command_registry')
  AND NOT EXISTS (
    SELECT 1 FROM public.settings s
    LEFT JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_command_registry' AND (
      sv.id IS NULL OR sv.category IS DISTINCT FROM s.category OR sv.scope_type IS DISTINCT FROM s.scope_type
      OR sv.value IS DISTINCT FROM s.cached_value OR sv.effective_until IS NOT NULL
      OR (SELECT count(*) FROM jsonb_array_elements(sv.value->'commands') command
        WHERE command->>'key' = 'provider_auth_configs.retire') <> 1
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(sv.value->'commands') command
        WHERE command->>'key' = 'provider_auth_configs.retire'
          AND command#>>'{execution,rpc}' = 'ui_retire_provider_auth_config_v1')
    )
  ), 'registry cache and current version retain the exact retirement command across scopes'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'ui_command_registry'
    AND change_reason = 'Add provider credential retirement action')
  AND NOT EXISTS (
    SELECT 1 FROM public.settings_versions promoted
    WHERE promoted.category = 'ui_command_registry'
      AND promoted.change_reason = 'Add provider credential retirement action'
      AND NOT EXISTS (
        SELECT 1 FROM public.settings_versions prior
        WHERE prior.category = promoted.category AND prior.scope_type = promoted.scope_type
          AND prior.scope_hash = promoted.scope_hash AND prior.id <> promoted.id
          AND prior.version < promoted.version AND prior.effective_until > prior.effective_from
          AND prior.schema_version IS NOT DISTINCT FROM promoted.schema_version
          AND jsonb_set(prior.value, '{commands}', COALESCE((
            SELECT jsonb_agg(item ORDER BY ordinality) FROM jsonb_array_elements(prior.value->'commands')
              WITH ORDINALITY AS entries(item, ordinality)
            WHERE item->>'key' IS DISTINCT FROM 'provider_auth_configs.retire'
          ), '[]'::JSONB), TRUE) = jsonb_set(promoted.value, '{commands}', COALESCE((
            SELECT jsonb_agg(item ORDER BY ordinality) FROM jsonb_array_elements(promoted.value->'commands')
              WITH ORDINALITY AS entries(item, ordinality)
            WHERE item->>'key' IS DISTINCT FROM 'provider_auth_configs.retire'
          ), '[]'::JSONB), TRUE)
      )
  ), 'retirement registry history retains closed predecessors, schema and unrelated commands'
);

CREATE FUNCTION pg_temp.provider_credential_retirement_behavior() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $test$
DECLARE
  v_org UUID := gen_random_uuid(); v_other_org UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid(); v_reader UUID := gen_random_uuid(); v_no_rbac UUID := gen_random_uuid();
  v_no_system UUID := gen_random_uuid();
  v_provider UUID := gen_random_uuid(); v_foreign_provider UUID := gen_random_uuid();
  v_config UUID := gen_random_uuid(); v_legacy UUID := gen_random_uuid(); v_marker UUID := gen_random_uuid();
  v_other UUID := gen_random_uuid(); v_foreign UUID := gen_random_uuid();
  v_secret UUID; v_fake TEXT := 'QA-RETIRE-NOT-A-REAL-SECRET-' || gen_random_uuid();
  v_policy JSONB; v_schema INTEGER; v_role UUID := gen_random_uuid();
  v_role_key TEXT := 'qa_retirement_' || replace(gen_random_uuid()::TEXT, '-', '');
  v_result JSONB; v_readback JSONB; v_saved JSONB; v_correlation UUID;
  v_active_readback JSONB; v_foreign_readback JSONB;
  v_audits BIGINT; v_decisions BIGINT; v_events BIGINT;
  v_call TEXT; v_foreign_call TEXT; v_legacy_call TEXT; v_marker_call TEXT;
BEGIN
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (v_org,'Credential retirement fixture','retirement-'||v_org,'active'),
    (v_other_org,'Foreign retirement fixture','retirement-'||v_other_org,'active');
  INSERT INTO public.providers(id,organization_id,name,provider_type,enabled) VALUES
    (v_provider,v_org,'Credential retirement provider','http',TRUE),
    (v_foreign_provider,v_other_org,'Foreign credential provider','http',TRUE);
  v_secret := vault.create_secret(jsonb_build_object('api_key',v_fake)::TEXT,
    'provider_auth_configs/'||v_config,'Rollback-only retirement fixture',NULL);
  INSERT INTO public.provider_auth_configs(id,provider_id,auth_type,credentials,credentials_vault_id,expires_at) VALUES
    (v_config,v_provider,'api_key',NULL,v_secret,now()+interval '1 day'),
    (v_legacy,v_provider,'api_key',jsonb_build_object('api_key',v_fake),NULL,NULL),
    (v_marker,v_provider,'api_key',jsonb_build_object('api_key',v_fake,'revoked',TRUE),NULL,now()-interval '1 day'),
    (v_other,v_provider,'api_key',jsonb_build_object('api_key','QA-UNTOUCHED'),NULL,NULL),
    (v_foreign,v_foreign_provider,'api_key',jsonb_build_object('api_key','QA-FOREIGN'),NULL,NULL);
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id) VALUES
    (v_actor,v_org,'retire-'||v_actor||'@example.test','Retirement operator','sender_user','active','tenant',NULL),
    (v_reader,v_org,'retire-'||v_reader||'@example.test','Retirement reader','sender_user','active','tenant',NULL),
    (v_no_rbac,v_org,'retire-'||v_no_rbac||'@example.test','No RBAC operator','sender_user','active','tenant',NULL),
    (v_no_system,v_org,'retire-'||v_no_system||'@example.test','No system writer','sender_user','active','tenant',NULL);
  INSERT INTO public.rbac_roles(id,organization_id,key,name) VALUES(v_role,v_org,v_role_key,'Retirement test role');
  INSERT INTO public.rbac_role_permissions(organization_id,role_id,permission_id)
    SELECT v_org,v_role,lv.id FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id=lv.lookup_definition_id
    WHERE ld.category='rbac_permission' AND lv.value IN ('agreements.read','agreements.write');
  DELETE FROM public.rbac_user_role_assignments WHERE user_id IN (v_actor,v_reader,v_no_rbac,v_no_system);
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id)
    VALUES(v_org,v_actor,v_role),(v_org,v_no_system,v_role);
  SELECT p.policy,(SELECT version FROM public.schema_registry WHERE category='access_control_policy'
    AND is_active ORDER BY version DESC LIMIT 1) INTO STRICT v_policy,v_schema
    FROM public.resolve_access_control_policy_v1('tenant',v_org,FALSE) p;
  v_policy := jsonb_set(v_policy,'{roles}',v_policy->'roles'||jsonb_build_array(
    jsonb_build_object('key',v_role_key,'capability_keys',jsonb_build_array('integration_plugins.write','system.write','provider_auth.read')),
    jsonb_build_object('key',v_role_key||'_read','capability_keys',jsonb_build_array('provider_auth.read')),
    jsonb_build_object('key',v_role_key||'_limited','capability_keys',jsonb_build_array('integration_plugins.write','provider_auth.read'))));
  v_policy := jsonb_set(v_policy,'{assignments}',COALESCE(v_policy->'assignments','{}')||jsonb_build_object(
    'user_id',COALESCE(v_policy#>'{assignments,user_id}','{}')||jsonb_build_object(
      v_actor::TEXT,jsonb_build_array(v_role_key),v_no_rbac::TEXT,jsonb_build_array(v_role_key),
      v_reader::TEXT,jsonb_build_array(v_role_key||'_read'),v_no_system::TEXT,jsonb_build_array(v_role_key||'_limited'))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',v_org,v_policy,v_schema,'Rollback-only retirement roles');
  SET CONSTRAINTS ALL IMMEDIATE;
  v_call := format('SELECT api.ui_retire_provider_auth_config_v1(%L,%L,ARRAY[%L]::TEXT[],%L,1,%L::JSONB)',
    'provider_auth_configs.retire','provider_auth_configs',v_config,v_config,'{"reason":"retire reviewed credential"}');
  v_foreign_call := replace(v_call,v_config::TEXT,v_foreign::TEXT);
  v_legacy_call := replace(v_call,v_config::TEXT,v_legacy::TEXT);
  v_marker_call := replace(v_call,v_config::TEXT,v_marker::TEXT);

  PERFORM set_config('request.jwt.claim.sub',v_reader::TEXT,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_reader,'role','authenticated')::TEXT,TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT throws_ok(v_call,'42501','Capability denied: integration_plugins.write','read-only actor cannot retire a credential');
  PERFORM set_config('request.jwt.claim.sub',v_no_rbac::TEXT,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_no_rbac,'role','authenticated')::TEXT,TRUE);
  RETURN NEXT ok(public.user_has_capability_v1('integration_plugins.write') AND public.user_can_write()
    AND NOT public.user_has_permission_v1('agreements.write',v_org),'missing RBAC is tested independently of capability grants');
  RETURN NEXT throws_ok(v_call,'42501','Provider credential retirement requires provider write authority','missing RBAC denies retirement');
  PERFORM set_config('request.jwt.claim.sub',v_no_system::TEXT,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_no_system,'role','authenticated')::TEXT,TRUE);
  RETURN NEXT ok(public.user_has_capability_v1('integration_plugins.write')
    AND public.user_has_permission_v1('agreements.write',v_org) AND NOT public.user_can_write(),
    'system write denial is independent of module capability and RBAC');
  RETURN NEXT throws_ok(v_call,'42501','Provider credential retirement requires provider write authority','system write is required');

  PERFORM set_config('request.jwt.claim.sub',v_actor::TEXT,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::TEXT,TRUE);
  RETURN NEXT ok(current_user='authenticated' AND auth.uid()=v_actor
    AND public.user_has_permission_v1('agreements.write',v_org),'positive caller uses the real authenticated role and existing provider permission');
  RETURN NEXT throws_ok(v_foreign_call,'P0002','Provider credential configuration unavailable','foreign configuration is uniformly unavailable');
  RETURN NEXT throws_ok(replace(v_call,'retire reviewed credential','  '),'23502','Provider credential retirement requires a reason','blank reason is rejected');
  RETURN NEXT throws_ok(replace(v_call,'''provider_auth_configs'',ARRAY','''providers'',ARRAY'),'22023',
    'Provider credential retirement requires one exact configuration selection','resource substitution is rejected');
  RETURN NEXT throws_ok(replace(v_call,',1,',',2,'),'22023',
    'Provider credential retirement requires one exact configuration selection','selection count substitution is rejected');
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',TRUE);
  RETURN NEXT throws_ok(v_call,'42501','Provider credential retirement requires an authenticated organization actor','missing actor is rejected');
  PERFORM set_config('request.jwt.claim.sub',v_actor::TEXT,TRUE);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','service_role')::TEXT,TRUE);
  RETURN NEXT throws_ok(v_call,'42501','Provider credential retirement requires an authenticated organization actor','service claim cannot bypass actor authorization');
  SET LOCAL ROLE service_role;
  RETURN NEXT throws_ok(v_call,'42501',NULL,'actual service role has no implicit execution authority');
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT throws_ok(v_call,'42501','Provider credential retirement requires an authenticated organization actor',
    'conflicting JSON service claim cannot bypass current capability checks');
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::TEXT,TRUE);
  SET LOCAL ROLE anon;
  RETURN NEXT throws_ok(v_call,'42501',NULL,'actual anonymous role cannot use forged authenticated claims');

  SET LOCAL ROLE authenticated;
  v_active_readback := api.ui_get_resource_v1('provider_auth_configs',v_config);
  v_foreign_readback := api.ui_get_resource_v1('provider_auth_configs',v_foreign);
  PERFORM set_config('request.correlation_id','11111111-2222-4333-8444-555555555555',TRUE);
  EXECUTE v_call INTO v_result;
  v_correlation := (v_result->>'correlation_id')::UUID;
  RETURN NEXT ok(v_result @> '{"ok":true,"changed":true,"idempotent_no_op":false}'::JSONB
    AND v_result->>'provider_auth_config_id'=v_config::TEXT AND v_correlation IS NOT NULL,
    'API retirement returns the same configuration ID and a valid UUID correlation');
  RETURN NEXT is(current_setting('request.correlation_id'),'11111111-2222-4333-8444-555555555555','correlation context is restored after retirement');
  v_readback := api.ui_get_resource_v1('provider_auth_configs',v_config);
  RETURN NEXT ok(v_readback->>'id'=v_config::TEXT AND (v_readback->>'expires_at')::TIMESTAMPTZ<=statement_timestamp()
    AND NOT(v_readback ?| ARRAY['credentials','credentials_vault_id']) AND position(v_fake IN v_readback::TEXT)=0,
    'existing safe API readback retains the row and displays expiry without credentials');

  SET LOCAL ROLE postgres;
  SELECT to_jsonb(pac) INTO v_saved FROM public.provider_auth_configs pac WHERE id=v_config;
  RETURN NEXT ok(v_saved->>'provider_id'=v_provider::TEXT AND v_saved->>'auth_type'='api_key'
    AND v_saved->'credentials_vault_id'='null'::JSONB AND v_saved#>>'{credentials,revoked}'='true'
    AND position(v_fake IN v_saved::TEXT)=0,'same row retains metadata but not usable credentials or its Vault reference');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE id=v_secret AND decrypted_secret::JSONB->>'api_key'=v_fake),
    'retirement does not delete or mutate the Vault secret payload');
  RETURN NEXT ok(public.get_provider_auth_credential(v_config, 'api_key') IS NULL
    AND public.get_provider_auth_credentials(v_config)->>'api_key' IS NULL,
    'existing credential resolvers cannot recover the retired Vault-backed key');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.provider_auth_configs WHERE id=v_other AND credentials->>'api_key'='QA-UNTOUCHED' AND expires_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.provider_auth_configs WHERE id=v_foreign AND credentials->>'api_key'='QA-FOREIGN' AND expires_at IS NULL),
    'other configurations including foreign configurations remain unchanged');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.decision_log WHERE resource_type='provider_auth_config' AND resource_id=v_config
      AND correlation_id=v_correlation AND decision_reason='retire reviewed credential' AND decision_inputs->>'actor_user_id'=v_actor::TEXT)
    AND EXISTS(SELECT 1 FROM public.domain_events WHERE resource_type='provider_auth_config' AND resource_id=v_config AND correlation_id=v_correlation)
    AND EXISTS(SELECT 1 FROM public.audit_table_changes WHERE table_name='provider_auth_configs' AND pk->>'id'=v_config::TEXT
      AND op='UPDATE' AND correlation_id=v_correlation), 'decision event and row audit bind the actor reason and UUID correlation');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.audit_table_changes WHERE table_name='provider_auth_configs' AND pk->>'id'=v_config::TEXT
    AND (position(v_fake IN COALESCE(row_old::TEXT,'')||COALESCE(row_new::TEXT,''))>0
      OR position(v_secret::TEXT IN COALESCE(row_old::TEXT,'')||COALESCE(row_new::TEXT,''))>0)),
    'audit before and after snapshots do not expose secret material or Vault references');
  SELECT count(*) INTO v_decisions FROM public.decision_log WHERE resource_type='provider_auth_config' AND resource_id=v_config;
  SELECT count(*) INTO v_events FROM public.domain_events WHERE resource_type='provider_auth_config' AND resource_id=v_config;
  SELECT count(*) INTO v_audits FROM public.audit_table_changes WHERE table_name='provider_auth_configs' AND pk->>'id'=v_config::TEXT AND op='UPDATE';
  SET LOCAL ROLE authenticated;
  EXECUTE v_call INTO v_result;
  SET LOCAL ROLE postgres;
  RETURN NEXT ok(v_result @> '{"changed":false,"idempotent_no_op":true}'::JSONB AND (v_result->>'correlation_id')::UUID=v_correlation
    AND (SELECT to_jsonb(pac)=v_saved FROM public.provider_auth_configs pac WHERE id=v_config)
    AND v_decisions=(SELECT count(*) FROM public.decision_log WHERE resource_type='provider_auth_config' AND resource_id=v_config)
    AND v_events=(SELECT count(*) FROM public.domain_events WHERE resource_type='provider_auth_config' AND resource_id=v_config)
    AND v_audits=(SELECT count(*) FROM public.audit_table_changes WHERE table_name='provider_auth_configs' AND pk->>'id'=v_config::TEXT AND op='UPDATE'),
    'idempotent_no_op retry preserves metadata and creates no duplicate mutation or audit evidence');
  SET LOCAL ROLE authenticated;
  EXECUTE v_legacy_call INTO v_result;
  EXECUTE v_marker_call INTO v_result;
  SET LOCAL ROLE postgres;
  RETURN NEXT ok((SELECT credentials->>'revoked'='true' AND position(v_fake IN credentials::TEXT)=0
    FROM public.provider_auth_configs WHERE id=v_legacy),'legacy JSON credentials are retired without deleting their row');
  RETURN NEXT ok(v_result->>'changed'='true' AND (SELECT position(v_fake IN credentials::TEXT)=0
    FROM public.provider_auth_configs WHERE id=v_marker),'legacy revoked marker with a secret is cleaned rather than accepted as a no-op');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.audit_table_changes WHERE table_name='provider_auth_configs'
    AND pk->>'id' IN (v_legacy::TEXT,v_marker::TEXT)
    AND position(v_fake IN COALESCE(row_old::TEXT,'')||COALESCE(row_new::TEXT,''))>0),
    'legacy JSON before and after audit snapshots remain secret-safe');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.settings s CROSS JOIN LATERAL jsonb_array_elements(s.cached_value->'commands') command
    WHERE s.category='ui_command_registry' AND s.scope_type='global' AND s.scope_id IS NULL
      AND command->>'key'='provider_auth_configs.retire' AND command->>'schema_category'='resource:provider_auth_configs'
      AND command#>>'{execution,rpc}'='ui_retire_provider_auth_config_v1'
      AND command#>>'{execution,input_schema,fields,0,required}'='true'),
    'existing provider ResourcePage receives the single-selection reasoned action');
  RETURN NEXT ok(v_active_readback->>'id'=v_config::TEXT
    AND (v_active_readback->>'expires_at')::TIMESTAMPTZ>statement_timestamp()
    AND NOT(v_active_readback ?| ARRAY['credentials','credentials_vault_id'])
    AND position(v_fake IN v_active_readback::TEXT)=0,
    'active credential API readback also excludes usable credentials and Vault references');
  RETURN NEXT ok(v_foreign_readback IS NULL,
    'provider metadata readback hides foreign configurations from the authenticated actor');
  RETURN NEXT ok(NOT EXISTS (
    SELECT 1 FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id AND sv.scope_hash=s.scope_hash
    CROSS JOIN LATERAL jsonb_array_elements(sv.value->'resources') resource
    WHERE s.category='ui_read_registry' AND resource->>'key'='provider_auth_configs'
      AND (resource->>'relation' IS DISTINCT FROM 'public.provider_auth_configs_visible_v1'
        OR resource ? 'read_relation'
        OR s.cached_value IS DISTINCT FROM sv.value)),
    'provider read routing remains on the visible view without a raw mutation relation');
  RETURN NEXT ok((SELECT reloptions @> ARRAY['security_invoker=true','security_barrier=true']
    FROM pg_class WHERE oid='public.provider_auth_configs_visible_v1'::REGCLASS)
    AND (SELECT array_agg(attname::TEXT ORDER BY attnum) FROM pg_attribute
      WHERE attrelid='public.provider_auth_configs_visible_v1'::REGCLASS AND attnum>0 AND NOT attisdropped)
      = ARRAY['id','provider_id','auth_type','expires_at','created_at','updated_at'],
    'provider metadata projection preserves caller security and exposes only safe columns');
END;
$test$;

SELECT * FROM pg_temp.provider_credential_retirement_behavior();
SELECT * FROM finish();
ROLLBACK;
